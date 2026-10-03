# TASK-25 evidence — port-forward reconcile and coalescing

**Status:** passed

## Step 2: supervisor ownership

| Concern | Owner before | Finding |
| --- | --- | --- |
| In-flight reconcile | module-level `inFlight` + `queued` | fixed in TASK-23 via shared `coalescer` |
| Grace timer | local `setTimeout` in `reconcilePortForwardsSoon` | correct — `unref`'d and cleared on both paths |
| `active` map (nodeId -> tunnelId) | module-level | **entries survived a failed teardown** |
| Stale group teardown | inline in `reconcilePortForwards` | guarded by `has()`, correct |
| Status persistence | `Promise.allSettled` | correct — one bad row does not strand the rest |
| Node cache | 30 s TTL, single slot | correct |

The whole reconcile was one function that read the database, deployed, removed
groups and wrote statuses. **Every failure path in it was unreachable from a
test**, because making the deploy fail needs an injected engine and the
supervisor uses a live singleton.

## Why a second test file, given the task's note

The note says port-forward tests already exist and to extend rather than build
a competing harness. Those three tests cover the *idle* and *concurrent* shapes
against a real empty database, and they still pass against the rewired
supervisor. They structurally cannot cover failure, stale-rule removal,
duplicates or tight-loop behaviour — not because they are weak, but because
those need an injected engine. So the new file covers exactly what the
integration harness cannot, and nothing it already does.

The decisions moved to `apps/web/src/lib/forward-supervisor-logic.ts` with the
I/O injected; the supervisor supplies the real engine and database.

## The three defects fixed

### 1. A failed teardown leaked an `active` entry forever

`active.delete(nodeId)` was only reached on the success path. If `remove()`
threw, the entry survived, the map grew for the process lifetime, and every
subsequent reconcile retried a removal that could never succeed. The delete is
now in a `finally`.

### 2. State was reported from desired configuration, not reality

The teardown path and the status write were the only places a rule's status was
derived, and a rule was marked `running` purely because the deploy call
returned. `selectForwardStatus` now takes an actual probe result, and
`probeOk === null` (unknown) is **not** reported as running — false reassurance
is the specific failure this prevents.

### 3. A per-group failure escaped the reconcile

Now contained: logged with the error, and every rule in that group reported as
`error`, while the other groups are still applied. Throwing would have abandoned
every other rule unreported.

Also preserved deliberately: **one attempt per group per reconcile**. A hidden
retry loop would multiply an already-30 s SSH timeout, and a test asserts three
reconciles make three attempts, not nine.

## Non-vacuity

| Mutation | Result |
| --- | --- |
| Never tear down stale groups | **FAIL** `a removed rule's group is torn down` |
| Keep the active entry when teardown fails | **FAIL** `the active group entry is cleared after teardown`, `an already-stopped group is forgotten too` |
| Report `running` from configuration alone | **FAIL** `a missing listener reports error`, `an unknown probe result does not claim running` |
| Rethrow a per-group deploy failure | **FAIL** `a throwing deploy is contained` |
| Restored | 24/24 |

Mutant D initially "failed" by crashing the suite with an unhandled
`node unreachable` and printing no summary — every assertion after it was
silently skipped. Containment is now tested first and in isolation, so a
rethrow mutant produces a clean, readable failure.

## Process errors

- Three tests initially passed a rule with `nodeId: null` and a node of type
  `FOREIGN` while the direction mapped to `IRAN`, so every status was
  `needs_node` and no deploy ever ran. Five assertions were measuring nothing.
- I asserted `active2.size === 1` for an already-stopped group, arguing the
  entry should be retained. My own implementation deletes it — and deleting is
  correct, since retaining it is exactly the leak described above. The
  assertion, not the code, was wrong.
- `setStatus` returned the Prisma row, which is not assignable to
  `Promise<void>`; the dead `resolveTargetNode` helper was removed once the
  planner took over that decision.

## Verified

- `test-forward-reconcile.ts` — 24/24
- `test-port-allocation.ts` — 27/27
- `test-bounded-caches.ts` — 29/29
- `test-diagnostics.ts` — 22/22
- `test-disposal-cleanup.ts` — 15/15
- `test-retry-bounds.ts` — 23/23
- `test-tunnel-lifecycle.ts` — 21/21
- `test-optimizations.ts` — 77/77, including the three pre-existing PortForward
  tests against the rewired supervisor
- `typecheck`, `lint`, line endings 54/54 — pass

**26/73 tasks passed.**
