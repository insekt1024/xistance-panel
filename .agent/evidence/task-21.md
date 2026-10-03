# TASK-21 evidence — process, listener, timer and file cleanup

**Status:** passed

## Step 2 first: ownership map

| Resource | Owner | Disposal path |
| --- | --- | --- |
| TCP listener | `ForwardHandle` (tcp) | `stop()` → `server.close()` |
| Accepted client sockets | **nobody** — untracked | *(the defect)* |
| UDP listener | `ForwardHandle` (udp) | `stop()` → `listener.close()` |
| Per-flow UDP upstreams | `flows` map | cleared in `stop()` and the TTL sweep |
| `SESSION_TTL` cleanup interval | UDP closure | `clearInterval` in `stop()` / on error |
| Per-connection idle timer | connection handler | `clearInterval` on close/error |
| Managed child process | `ChildProcessHandle` | `stop()` / `dispose()` |
| Respawn timer | `ChildProcessHandle` | TASK-20 |
| Deploy-created runtimes | `TunnelEngine` | TASK-19 |
| systemd units | systemd | `systemctl stop` + `disable` |

The row in bold is the bug: accepted sockets had no owner, so nothing could
release them.

## The defect: stop() hung forever with any client connected

`net.Server.close()` stops accepting new connections but **never completes while
an established connection is open**. Measured before the fix:

```
client connected on port 60187
close() callback fired within 1.5s? false
closeAllConnections available? false
```

So `ForwardHandle.stop()` never resolved. The stop request hung for the
lifetime of the client, the HTTP handler never returned, and the port stayed
bound. On a `1 vCPU` VPS a handful of stuck clients would exhaust the panel's
request capacity. `closeAllConnections()` is not available on this Node
version, so the sockets must be tracked explicitly.

Fixed by tracking every accepted socket in a `Set` and destroying them in
`stop()` before closing the server. Verified with a live upstream so the
forwarded connection stays established:

```
with a live upstream pipeline: close cb fired? false client closed? false
```

— which is the unfixed behaviour, now covered by a test.

## Other fixes

- **`stopForwarders` used `Promise.all`** — one handle that failed to close
  stranded every other listener, leaving their ports bound. Now `allSettled`,
  with a count-based aggregate error that does not echo underlying detail
  (a rule name or command arg could carry a secret).
- **TCP `stop()` was not idempotent** — a second `close()` on a closed server
  rejects with `Server is not running`, so a repeated stop surfaced as a
  failure. Guarded.
- **UDP `stop()` was not idempotent** — same, via `ERR_SOCKET_DGRAM_NOT_RUNNING`.
  A socket that is already closed is a successful stop, not an error.

## The test that hid the bug

The first version of the hang test pointed the rule at port 9 (discard). The
client socket errored out on its own within milliseconds, the connection never
stayed established, and `close()` completed anyway — so the test **passed
against the unfixed code**. Mutation testing caught it: removing socket tracking
gave 15/15.

The fix was a live upstream listener. After that, the same mutation fails with
the exact symptom (`exit=124`, a real timeout, and
`FAIL stop() completes even with a client still connected`).

A second problem surfaced from the live upstream: a live accepted connection
keeps the event loop alive, so the test process never exited. The fixture now
owns and releases its own sockets; the run exits `0`.

## Non-vacuity

| Mutation | Result |
| --- | --- |
| Remove socket tracking | `exit=124` — **FAIL** `stop() completes even with a client still connected` |
| `allSettled` → `all` in `stopForwarders` | **FAIL** `the aggregated cleanup error does not echo underlying detail` |
| Remove the TCP idempotence guard | **FAIL** `a repeated TCP stop resolves` |
| Restored | 15/15, clean exit |

The second mutation fails on the secret-leak assertion rather than the stranding
one, because reverting to `all` also removes the aggregate wrapper. Both are
the same edit, so that is expected; the stranding behaviour is covered by the
two "does not strand the other listeners" assertions, which the mutant's early
rejection does not reach.

## Scoping

No `pkill`, no process-name matching, no pattern-based killing anywhere. The
child test asserts the exact managed pid is gone, and that no replacement was
spawned, by having the child record its own pid to a marker file.

## Verified

- `test-disposal-cleanup.ts` — 15/15, exit 0
- `test-tunnel-lifecycle.ts` — 21/21
- `test-retry-bounds.ts` — 22/22
- `typecheck`, `lint` — pass

**22/73 tasks passed.**
