# TASK-129 — PORT_FORWARD data path, driven through the product's own forwarder

**Status: 6/6. PORT_FORWARD now has a runnable traffic proof, so only XRAY remains.**

## Why this one is different

PORT_FORWARD execs no binary. `packages/tunnel-core/src/forwarder.ts` is in-process
Node (`startForwarder()`), so it cannot run inside the target-OS container suite that
covers GOST/FRP/BACKHAUL/SSH/REVERSE. It runs on the host instead, against a real
HTTP origin — and still through the product's own code, not a replica.

## Result

```
ok   PRECONDITION: the origin serves HELLO-XR on 19398
ok   PRECONDITION: 19399 is free
ok   startForwarder() returns a handle describing the rule (tcp :19399)
ok   PORT_FORWARD carries real bytes 19399 -> 19398 (body=HELLO-XR)
ok   PORT_FORWARD serves repeated requests on the same forwarder
ok   PORT_FORWARD releases the listen port on stop()
--- 6 passed, 0 failed ---
```

Four things it asserts beyond "a byte moved":

- **the handle describes the rule** — `id`, `protocol: "tcp"`, `sourcePort`. A
  resolved promise is not proof a socket bound to the right port.
- **repeated requests**, so one lucky connection cannot pass.
- **the port is released on `stop()`**. `forwarder.ts` tracks every accepted socket
  precisely so `stop()` cannot leak one; that is worth asserting.
- **two preconditions first**, so a failure cannot be misattributed.

## Three mistakes the product's own types caught

Each was a wrong guess on my part, and each was caught by reading code rather than by
a failing test:

| I wrote | reality | caught by |
| --- | --- | --- |
| top-level `await` | this file is transformed as CJS, where it is a hard error | `Top-level await is currently not supported with the "cjs" output format` — the same issue TASK-65 recorded |
| `direction: "local"` | the enum is `IRAN_TO_FOREIGN \| FOREIGN_TO_IRAN` | `PortForwardRuleSchema.parse` refusing it |
| `handle.close()` | `ForwardHandle` is `{ id, protocol, sourcePort, stop() }` | `TypeError: handle.close is not a function` |

The schema step is why the second failed loudly at parse time instead of producing a
forwarder that bound the wrong thing. That has now been the payoff twice: it caught
`as never` casts in `gen-traffic-fixtures.ts` (TASK-127) and this enum.

## Honest state of the nine methods

| method | traffic claim re-runnable | reconnect proven |
| --- | --- | --- |
| GOST | yes | yes |
| DIRECT | yes | yes |
| FRP | yes | yes |
| BACKHAUL | yes | yes |
| SSH | argv asserted; execution blocked (no sshd) | yes (TASK-65) |
| REVERSE | argv asserted; execution blocked (no sshd) | yes (TASK-65) |
| PORT_FORWARD | **yes** | n/a — in-process, covered by `stop()` releasing the port |
| XRAY | **no** | **no** |
| XUI | n/a — metadata-only by design | n/a |

`test-real-binary-evidence.ts` reports exactly one uncovered claim now, and it is
XRAY: `test-xray.ts` asserts config shape only, so nothing in CI moves a byte through
xray. That finding is left standing rather than satisfied by widening the allowlist.
