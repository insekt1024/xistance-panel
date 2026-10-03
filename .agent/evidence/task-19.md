# TASK-19 evidence — shared tunnel process state transitions

**Status:** passed

## Two real defects, found by driving the actual engine

Both were reproduced with a scripted `ProcessHandle` double injected through a
new `EngineOptions.createProcessHandle` seam, so the real planner, the real
`deploy()`, and the real `stop()`/`remove()` paths execute.

### Defect 1 — a partially failed deploy orphaned running processes

`deploy()` started every planned process and only afterwards recorded the
runtime. If the second start threw, the first process was already running on
the host, but nothing in `runtimes` referenced it. It could not be stopped,
removed or redeployed — a tunnel process with no way to kill it, invisible to
the dashboard.

```ts
// before: started processes were never torn down on failure
await Promise.all(procs.map((p) => p.handle.start()));
this.runtimes.set(spec.id, { processes: procs, method: spec.method });
```

Now starts are tracked as they succeed, and any failure disposes exactly what
was started, deletes the runtime, invalidates the caches, and rethrows the
original error so the caller's error type is preserved.

### Defect 2 — stop() was not idempotent

Every `stop()` re-issued `systemctl stop` + `disable` (or a second SIGTERM) for
processes already stopped. The acceptance criteria require idempotency, and a
stop button an operator can mash should not turn into a burst of remote
commands.

`stop()` now consults evidence first (`isRunning()` per handle) and only stops
what is still running. If the evidence call itself fails, the process is
assumed running — skipping a real process is worse than a redundant stop.

### Bounded teardown

Added `disposeAll()` with a 15 s per-process bound via `withTimeout()`. A handle
that never settles (wedged SSH session, unresponsive unit) previously hung the
HTTP request indefinitely. Cleanup failures are aggregated and **reported**, not
swallowed: a unit that could not be stopped is a real problem the operator must
see.

## Non-vacuity

| Mutation | Result |
| --- | --- |
| Remove the orphan cleanup from `deploy()` | `FAIL no orphan process after a failed deploy` |
| Make `stop()` unconditional again | `FAIL a repeated stop is a no-op` |
| Restored | 19/19, then 21/21 with the bound test added |

## Test seam

`EngineOptions.createProcessHandle` is optional and defaults to the existing
`ProcessManager`, so production behaviour is unchanged. It exists because the
lifecycle guarantees are only provable against a handle that can be scripted to
fail or hang; the alternative is a real spawn that cannot fail on demand.

The deploy spec is a real `PORT_FORWARD` plan over two local nodes, which
produces two process entries and exercises the parallel paths without any SSH.

## Process errors I made and fixed

- First draft of the tests exercised only the doubles, not the engine — the
  same vacuity trap hit three times in this project. The `createProcessHandle`
  seam was added specifically so the assertions run against real engine code.
- The first spec used `XUI`, which plans zero processes, so every assertion
  passed against an empty handle list. Switched to `PORT_FORWARD` with one rule
  per direction.
- `buildPlan` dispatches on `spec.config.method`, not `spec.method`; the initial
  spec put it in the wrong field and threw `Unsupported tunnel method: undefined`.
- A double read `this.failStart` where the field is `this.opts.failStart`, so
  the failure path never triggered and the test asserted nothing.

## Verified

- `test-tunnel-lifecycle.ts` — 21/21
- `test-optimizations.ts` — 77/77
- `typecheck`, `lint` — pass

**20/73 tasks passed.**
