# TASK-35 evidence — all-method regression matrix

**Status:** passed

## What this task was really asking

Nine methods, one release. The per-method suites had grown unevenly, so a green
suite did not mean "the method was verified" — it often only meant "the config
builder was verified". Nothing compared the nine against each other, so a
coverage gap was a missing section rather than a failing test.

`scripts/lib/method-contract.ts` applies one contract to all nine.
`scripts/test-method-matrix.ts` records the result per method and writes
`.agent/evidence/tunnel-matrix.{json,md}`.

## The real defect this found

**`stop()` and `computeStatus()` awaited `handle.isRunning()` with no timeout.**

For a remote node that probe is an SSH session. A hung session answers nothing,
so:

- the stop button never came back on a genuinely unreachable host;
- every status poll — and therefore every UI refresh — hung with it.

The `withTimeout` in the engine wrapped only `handle.stop()` inside
`disposeAll`, so the bound existed for the teardown and not for the probe that
decides what to tear down.

Fixed with `IS_RUNNING_TIMEOUT_MS = 5_000`, applied to both call sites. On
timeout the process is treated as **still running**: a redundant stop is
harmless, a skipped one orphans a process on a host the panel can no longer
reach. The status path treats a timeout as not-running, because the alternative
is a panel that never loads.

This is the class of bug the matrix existed to find, and it is only visible by
running the same lifecycle against a process that refuses to answer.

## Evidence shape, and what it does not claim

Every row is `local_command + injected_process`. The engine lifecycle, cleanup,
and resource guarantees are genuinely exercised through a real `TunnelEngine`
with a scriptable handle — that is what makes idempotent stop and partial-deploy
cleanup provable at all. **No tunnel binary was executed, no traffic crossed a
tunnel, and no remote node was contacted.** `realBinary` is `false` for all nine
and `releaseComplete` is `false` for all nine, so the release gate stays shut
until a real-binary/VPS pass exists per method. The matrix asserts this itself:
a test fails if any row ever claims real-binary evidence.

## Mutation testing: 6/6

Reverting a real fix must change the outcome.

| Mutant | Result |
| --- | --- |
| A — unbounded `isRunning` in `stop()` | killed (hangs; exit 124) |
| B — idempotent-stop guard removed | killed, 42/50 |
| C — `restart()` is a no-op | killed, 42/50 |
| D — `remove()` leaves the runtime | killed, 41/58 |
| E — partial-deploy rollback removed | killed, 48/50 |
| F — unbounded `isRunning` in `computeStatus` | killed (hangs; exit 124) |

A and F hang rather than fail, which is the correct signal for an unbounded
`await`. Each run is wrapped in `timeout`; a hang is recorded as a kill, not as
a slow test.

## Three defects in my own test code

**Two false leaks (BACKHAUL, FRP).** `ScriptedHandle` started with
`running = true`, so a handle whose `start()` threw looked like an orphaned
process. The engine had in fact done the right thing and stopped the one
process that had really started. The leak predicate now counts
`startedOk` — successful starts — not `running`.

**A vacuous removal check.** "A removed tunnel reports stopped" passed even
with the runtime entry surviving, because `disposeAll` had already stopped the
handles by then. The property that matters is that the tunnel is no longer
*tracked*. Mutant D survived until this was fixed.

**A missing status-poll check.** The resource block set handles uninterrogable
and then only called `stop()`, so mutant F survived. `computeStatus` needs its
own bounded-status assertion.

**Two config shapes I invented.** Four methods failed to parse: `NodeType.IRAN`
and `PortForwardDirection.IRAN_TO_FOREIGN` are UPPER_SNAKE, and
`FrpProxySchema` wants `localIP`. The earlier "out-of-range port" probe mutated
a *top-level* `listenPort` that no method schema reads — it proved nothing for
permissive schemas and failed spuriously for strict ones. Both now derive from
the production schemas.

**One harness hang worth knowing.** A `ScriptedHandle` without `restart()` and
`dispose()` throws inside an `await` loop with no catch; the suite hangs with no
error message. Both are part of the `ProcessHandle` contract and are now
implemented.

## Regression

16 method/runtime suites green, optimization harness 77/77, line endings 54/54,
`packages/types` and `packages/tunnel-core` builds, typecheck, lint 0 errors.

## Not proven

- Real traffic for any of the nine methods.
- Privileged-port binding as an unprivileged user.
- Behaviour on a real 1 vCPU / low-RAM VPS under load.
- Any `arm64` or Ubuntu 22.04 run.
