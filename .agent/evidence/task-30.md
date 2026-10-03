# TASK-30 evidence — PORT_FORWARD method coverage

**Status:** passed

## The finding: two forwarders, one fixed and one forgotten

`forwarder.ts` (the library, used in dev) and `forwarder-runner.ts` (the
**production worker** run under the systemd unit) were two independent
implementations of the same forwarder. TASK-21 fixed the library's teardown.
**The worker never received any of it** — and the worker is what actually runs
in production.

| Defect in the worker | Consequence |
| --- | --- |
| No accepted-socket tracking | `server.close()` never completed while a client was connected. The systemd unit would sit in `deactivate` until `TimeoutStopSec` killed it. This is TASK-21's exact defect, still live. |
| No `stopped` guard on TCP `stop()` | A repeated stop rejected with `ERR_SERVER_NOT_RUNNING`. |
| No `stopped` guard on UDP `stop()` | A repeated stop rejected with `ERR_SOCKET_DGRAM_NOT_RUNNING`. |
| `server.close(() => res())` discarded the error | Swallowed the rejection above, hiding it. |
| `Promise.all` in the batch rollback | One failing teardown propagated out of the `catch` that was about to report a *different* error (the bind failure), replacing it. |

All five are fixed. The batch rollback is now `rollbackHandles()`, extracted so
the selftest exercises the **shipped** function — while it was inline, a
mutation to the production line was invisible because the test had its own copy.

## A false "reproduction" I had to discard

My first external probe reported:

```
exited within 8s? false (8088ms, code=null)
VERDICT: runner stop() HANGS with a live client -- REPRODUCED
```

**That was wrong.** A control case with *no client connected* also hung, and
`XT_FORWARDER_SHUTDOWN` never printed — the SIGTERM handler never ran. A minimal
child registering nothing but `process.on("SIGTERM", …)` also never ran its
handler under `child.kill("SIGTERM")` on this Windows host:

```
child exit code: null in 5042 ms
child said: "READY"
```

So the probe was measuring Windows signal semantics, not the runner. The runner
is Linux-targeted, where SIGTERM works; the conclusion was an artifact.

Fixed by adding `--selftest`, which runs the shipped `startTcp`/`startUdp`/
`rollbackHandles` **in-process** and reports a verdict. The signal path is
genuinely untestable from outside on this host, and that limitation is stated
in the source rather than papered over.

## Verification

`node --experimental-strip-types forwarder-runner.ts --selftest` →
`XT_SELFTEST_PASS tcp stop settled in 79ms with a live client; idempotent;
batch rollback and udp stop verified`

It covers: TCP stop with a real established client; repeated and concurrent
stop; batch rollback releasing a bound port; rollback isolation (a failing
handle must not strand a healthy listener, and must not propagate); UDP stop
and repeated UDP stop. The file stays **Node-builtins-only**, as the task
requires.

## Actual-vs-desired state: `selectForwardStatus` was dead code

TASK-25 added `selectForwardStatus({enabled, probeOk})` to convert a real probe
into a status. It was exported and unit-tested but **never called** — the
supervisor hardcoded `"running"` whenever `deploy()` resolved, and the API
returns that DB column. A deploy can return while the process dies immediately,
so the UI showed a tunnel that was not forwarding.

`planGroupsAndApply` now consults `deps.has(tunnelId)` after a successful
deploy. Unknown/missing is reported as `error`, never as false reassurance.

## Non-vacuity

| Mutation | Result |
| --- | --- |
| Worker: remove socket tracking | **FAIL** 2 (`stop() did not settle within 5000ms`) |
| Worker: remove TCP `stopped` guard | **FAIL** 2 |
| Worker: `allSettled` → `all` in rollback | **FAIL** 1 |
| Worker: remove UDP `stopped` guard | **survives — equivalent mutant** |
| Library: `allSettled` → `all` in `stopForwarders` | **FAIL** 2 |
| Library: remove socket tracking | **FAIL** 1 |
| Revert the `selectForwardStatus` wiring | **FAIL** 1 |

The surviving mutant is a **genuine equivalent mutant**, verified rather than
assumed: the `try/catch` around `listener.close()` independently absorbs
`ERR_SOCKET_DGRAM_NOT_RUNNING`, so removing only the `stopped` guard changes no
observable behaviour. The guard is kept and the redundancy is documented at the
code, because the guard also avoids re-clearing the TTL interval and re-closing
every upstream flow, which the `try/catch` does not prevent.

## Process errors, including three of my own

1. **False reproduction** (above) — discarded and the platform difference
   verified.
2. **Windows bind-address conflict.** Fixtures squatted on `127.0.0.1` while
   the forwarder binds `0.0.0.0`; Windows does not treat those as conflicting,
   so the "port conflict" test bound successfully and the batch-rollback test
   could not reach its failure path. Both now squat on the same wildcard
   address, and the worker's bind address is a single named `BIND_ADDR` constant
   so the two implementations cannot drift.
3. **Privileged port as a failure trigger.** The batch-rollback selftest first
   used port 1 to provoke `EACCES` — which does not fire for root, so the path
   was silently skipped. It now occupies the port the second rule wants, so the
   failure is `EADDRINUSE` for any user on any platform.
4. **A mutant surviving that was a real gap, not equivalence.** `stopForwarders`
   under `all()` leaked the raw internal error instead of the sanitised
   aggregate. The test only asserted "it throws"; it now asserts the message is
   the aggregate and that the internal text does not leak.
5. **My own harness masked a hang.** I killed a background mutation run
   mid-mutant, which left mutant A in the source tree. A later run then reported
   2 failures against a "known good" file. Restored from the saved copy and
   added an `EXIT` trap so a killed run restores the tree. This was my error, not
   a product defect.
6. **The suite hung after printing its summary.** A client socket destroyed but
   not awaited kept the loop alive, so every run exited on the outer timeout
   rather than reporting a verdict. Fixed by awaiting `'close'` on both ends; a
   lingering-handle census now names any future leak instead of hanging silently.
   The library `stop()` await is also bounded, so that regression surfaces as one
   named failure rather than a dead suite.

## Not claimed

**No real forwarded traffic through a production systemd unit on Linux, and no
remote-node `IRAN_TO_FOREIGN` / `FOREIGN_TO_IRAN` group deploy.** This is a
Windows host with no tunnel binaries and no second node. The local forwarding
path is proven against real sockets (bytes echoed end-to-end, real bind, real
release); the cross-node group deploy and the systemd lifecycle are not, and join
the BACKHAUL/FRP/GOST/SSH items in the VPS acceptance pass.

## Verified

- `test-port-forward.ts` — 29/29 · `test-forward-reconcile.ts` — 26/26
- `test-ssh.ts` — 50/50 · `test-gost.ts` — 37/37 · `test-frp.ts` — 28/28
- `test-backhaul.ts` — 39/39 · `test-port-allocation.ts` — 27/27
- `test-bounded-caches.ts` — 29/29 · `test-diagnostics.ts` — 22/22
- `test-disposal-cleanup.ts` — 15/15 · `test-retry-bounds.ts` — 23/23
- `test-tunnel-lifecycle.ts` — 21/21
- `test-optimizations.ts` — 77/77 · `test-line-endings.sh` — 54/54
- `typecheck`, `lint` — pass

**31/73 tasks passed.**
