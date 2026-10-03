# TASK-24 evidence — port allocation and conflict reporting

**Status:** passed

## Step 2: allocation callers

`findFreePort` had exactly two callers, both in
`apps/web/app/api/port-forwards/route.ts`: the read-only `?free=1` suggestion
probe, and the auto-allocation branch of the create handler. The
check-then-create in the create handler was:

1. `collectUsedPorts()` — tunnel + rule ports **from the database only**;
2. `findFreePort(used)` — first free number in the range;
3. a separate `findFirst` for a same-protocol/same-node rule;
4. `prisma.portForward.create`.

## The two real defects

### 1. The OS was never consulted

`findFreePort` only ever knew about the database. A port could be free in
SQLite and already held by an unrelated process on the host — the panel would
hand it out, the rule would be created, and the failure would surface later as
a generic tunnel failure at deploy time, with nothing in the message saying
"port conflict". That is precisely the gap the acceptance criteria name.

`isPortOccupied` now performs a real bind probe. It binds rather than parsing
`ss`/`netstat`, because parsing is platform-specific, racy, and often absent
in a slim container. **Probe errors are reported as occupied**: skipping a
genuinely free port costs the user one number, while handing out a busy one
fails later and more confusingly.

### 2. `null` conflated "exhausted" with "not found"

`findFreePort` returned `number | null`, and the caller turned `null` into a
generic 409 string. The caller could not tell range exhaustion from any other
cause, and nothing carried a machine-readable code.

Now: `PortRangeExhaustedError` (`PORT_RANGE_EXHAUSTED`), `PortConflictError`
(`PORT_CONFLICT`, carrying port + protocol + holder), and
`PortRangeInvalidError` (`PORT_INVALID_RANGE`). `findFreePort` keeps its
historical `number | null` contract because the read-only `?free=1` probe must
not start throwing on a path that only renders a suggestion.

## Reservation strategy (the task's technical note)

An OS-level check is **not atomic**. Binding a probe, releasing it, and
returning the number leaves a window in which another process takes the port.
This is documented in the module rather than papered over. What is actually
achieved:

1. `isPortOccupied` is checked during allocation, so a port held outside the
   panel is skipped rather than handed out;
2. within a batch, each candidate is considered exactly once;
3. the residual cross-process race is narrowed, not eliminated, and surfaces as
   a `PortConflictError` at bind time instead of a silent double-bind.

The create route now also checks `isPortOccupied(sourcePort)` for a
user-specified port, so the conflict is reported at creation rather than at
deploy.

## Dead code found by mutation testing

`allocatePorts` kept a `reserved` Set, and the comment claimed it was "what
makes the batch collision-free". Mutation testing removed it and **nothing
failed** — because the loop's `p` counter already guarantees each candidate is
considered once. The set was dead code carrying a misleading safety claim, so
it was deleted rather than left as false comfort. The async variant keeps its
`taken.add` because an `await` between iterations means a caller could
otherwise observe a half-built batch.

## Non-vacuity

| Mutation | Result |
| --- | --- |
| `allocatePort` ignores the occupancy probe | **FAIL** `a port occupied by another process is skipped`, `a range busy at the OS level reports exhaustion` |
| Remove batch reservation (dead code) | passed — correctly, it was dead; removed |
| `isPortOccupied` inverts its result | **FAIL** `isPortOccupied detects a real bound socket` |
| Restored | 27/27 |

## Process errors

- I first wrote one `PortOccupancyProbe` typed as async and had the sync
  allocator accept it. A Promise is truthy, so every port looked occupied and
  the allocator threw immediately. Split into `SyncPortOccupancyProbe` and
  `PortOccupancyProbe` with matching entry points.
- The OS-occupancy test bound `127.0.0.1` while the probe binds `0.0.0.0`; the
  two do not reliably conflict, so the probe reported "free". Now both bind
  all interfaces.
- My rewritten "concurrent" test failed against *correct* code: two batches
  that share no state cannot collide, and that is by design (the allocator is a
  pure function, not a global registry). Rewritten to model the real
  call pattern — the second batch receives the first's ports as `used`.
- **A flaky assertion surfaced in TASK-20's suite.** `an explicit start resets
  the attempt streak` asserted `attempts === 0` after a 30 ms settle, but the
  spec's child exits immediately and bumps it to 1. It had been passing on
  timing luck. Replaced with a deterministic assertion plus an
  `exhausted === false` check; confirmed stable over three consecutive runs.

## Verified

- `test-port-allocation.ts` — 27/27
- `test-bounded-caches.ts` — 29/29
- `test-diagnostics.ts` — 22/22
- `test-disposal-cleanup.ts` — 15/15
- `test-retry-bounds.ts` — 23/23
- `test-tunnel-lifecycle.ts` — 21/21
- `typecheck`, `lint`, line endings 54/54 — pass

**25/73 tasks passed.**
