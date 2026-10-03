# TASK-20 evidence — bounded retries and reconnect loops

**Status:** passed

## Step 2 first: every timer path and its owner

| Path | Owner | Cancellation |
| --- | --- | --- |
| `process.ts` respawn timer | `ChildProcessHandle` | `stop()`, `dispose()`, and the next `start()` — **but not when the timer fired** |
| `process.ts` SIGKILL escalation | `stop()` / `dispose()` | `clearTimeout` after exit |
| `engine.ts` `withTimeout` rejection | per-operation | `finally { clearTimeout }` |
| `engine.ts` stats debounce | `TunnelEngine` | `invalidateStatus()` |
| `forwarder-runner.ts` flow cleanup | per-UDP-flow | `clearInterval` on error/exit |
| `forwarder.ts` idle timers | per-listener | `clearInterval` on close |
| systemd `Restart=on-failure` + `RestartSec=5` | systemd | systemd policy |
| `AUTOSSH_POLL` | autossh | external |

`autosshPoll` was checked and is already bounded by Zod to 1–3600 s, so it
needed no change. The intentional autossh reconnect behaviour is untouched.

## Three real defects

### 1. The backoff never escalated — the respawn reset its own state

`startOnce()` set `retryDelay = 0` on entry. Because a respawn goes *through*
`start()`, every retry cleared the accumulated delay before using it, so a
crash-looping command was respawned **forever at the base delay** — no
escalation, no exhaustion, and a 2-second spin for as long as the process lived.

Fixed by distinguishing intent: an explicit `start()` is a fresh attempt and
resets the streak, while a respawn carries the streak forward. Measured
escalation is now `1000 → 2000 → 4000 → 8000 ms`.

### 2. Retries were unbounded and had no terminal state

Nothing stopped a permanently failing process, and nothing reported that it had
given up. `scheduleRetry()` now honours an attempt ceiling (default 10), sets
an explicit `exhausted` state, cancels any pending timer, and advertises
`nextDelayMs: null`. `stop()` and an explicit `start()` both clear it.

### 3. `start()` was unserialised — concurrent starts could spawn twice

Right after an exit `child` is `null`, so a manual start and a scheduled respawn
both passed the old `if (this.child) return` guard and both spawned. The
handle tracked one child; the other was unkillable. Starts are now serialised
through a single `startSerialized()` path.

Additionally, the respawn timer was never nulled when it fired, so `stop()`
believed a retry was pending after it had already run. The callback now clears
it before starting.

## Bounded, allowlisted policy

`ProcessSpec.retry` is the only input, clamped once by `clampRetryPolicy()`:
non-positive, non-finite and out-of-range values are all replaced, so no
configuration can produce a zero delay (tight loop), an infinite delay, or an
unbounded attempt count. `maxAttempts: null` is the only way to retry forever,
and it is opt-in.

## Testing without waiting

An injected `RetryScheduler` (setTimeout / clearTimeout / now) lets the tests
drive a deterministic clock. This matters: a 30-second ceiling cannot be
asserted in CI by waiting for it. `retryState()` exposes attempts, last delay,
next delay and exhaustion for diagnostics, and contains no secrets.

## Non-vacuity — and a test that had to be rewritten

| Mutation | Result |
| --- | --- |
| Respawn resets its own backoff | `FAIL repeated failure reaches a terminal state` (3 failures) |
| Remove the attempt ceiling | `FAIL repeated failure reaches a terminal state` (3 failures) |
| Unserialise `start()` | initially **passed** — see below |
| Restored | 22/22 |

The concurrency test passed against the broken code, so it proved nothing. Two
reasons: the fake clock fires timers synchronously so the race cannot occur, and
the assertion only compared pids the handle itself reported — the orphan is by
definition unobservable from there. It now counts spawns at the OS boundary
(each child appends to a marker file), and with the unserialised code it fails
`three concurrent starts spawn exactly one child`.

## Process errors

- A field initialiser `private readonly policy = clampRetryPolicy(this.spec.retry)`
  ran before `spec` was assigned and threw on every construction. Moved into the
  constructor body.
- Renaming `respawnDelay` → `retryDelay` missed the declaration, and typecheck
  caught all eight sites (tsx does not typecheck, so the runtime tests passed).
- The first backoff assertion saw only one delay value (`1000 ms`) and was
  passing while the escalation was broken — the same "green but testing
  nothing" pattern. Only reading the actual sequence exposed it.

## Verified

- `test-retry-bounds.ts` — 22/22
- `test-tunnel-lifecycle.ts` — 21/21
- `test-optimizations.ts` — 77/77
- `typecheck`, `lint` — pass

**21/73 tasks passed.**
