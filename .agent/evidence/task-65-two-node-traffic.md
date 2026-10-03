# Real-binary evidence: DIRECT, PORT_FORWARD, REVERSE (TASK-65, the last 3 reachable methods)

Date: 2026-09-30
Target: **Ubuntu 22.04.5 LTS, amd64, systemd PID 1** — privileged Docker containers
from image `xt-target:22.04`. Exact-OS container evidence, **not** remote-VPS
evidence. All tunnel values are **throwaway probe values generated inside the
containers**; no real host, user, port, key, or token appears here — all such
values are `[REDACTED]`.

Result: **DIRECT 2/2, PORT_FORWARD 3/3, REVERSE 5/5.** Real-binary coverage is now
**8 of 9 methods**.

---

## The "no reachable remote node" claim was wrong again

The previous session recorded PORT_FORWARD, DIRECT and REVERSE as unproved
because they "reach a REMOTE node" and none was available. That is the same
error I had already made once with Docker and with WSL, and I had written the
lesson down. The environment was in front of me the whole time: **two running
containers are two nodes.**

A dedicated Docker network makes them genuinely separate hosts:

```
xt22  172.18.0.2   tunnel node (Iran side) — has the pinned tunnel binaries + sshd
xt24  172.18.0.3   foreign peer — serves the destination service
xtrel 172.18.0.4   spare node
```

`ping` between them fails — ICMP is filtered — which briefly read as "the nodes
cannot reach each other". **It is not a reachability signal.** The check that
matters is a real TCP connect, and that works:

```
TCP_OK 172.18.0.3:19099
HELLO-FAR
```

A probe that concludes "the two nodes are isolated" from `ping` alone will
report a false blocker. Use a socket.

---

## DIRECT — 2/2

Driven by the exact argv `buildDirectCommand()` emits:

```
gost -L tcp://:19120/172.18.0.3:19099
```

| # | assertion | evidence |
|---|---|---|
| 1 | **traffic crossed to the peer** | `127.0.0.1:19120` (gost) → peer `172.18.0.3:19099` → `HELLO-FAR` |
| 2 | reconnect | killed, traffic stopped, recovered (pid 5251 → 5270) |

**One harness detail worth recording.** `buildDirectCommand()` emits the bare
program name `gost`; the binary lives in `/var/lib/xistance/bin`, which is not on
`PATH`. The first run failed with `nohup: failed to run command 'gost': No such
file or directory` — a probe bug, not a product one, because the engine resolves
that path itself. The probe now resolves argv[0] against the tunnels bin dir.

## PORT_FORWARD — 3/3

Not a third-party binary: the product's **own relay daemon**, called through its
real entry point `startForwarder()` from
`packages/tunnel-core/src/forwarder.ts` (transpiled for the target, not
reimplemented), with a rule in the product's own `PortForwardRule` shape:

```json
{ "protocol": "tcp", "sourcePort": 19130, "destHost": "172.18.0.3", "destPort": 19099 }
```

| # | assertion | evidence |
|---|---|---|
| 1 | relay daemon alive | pid 5286 |
| 2 | **traffic crossed to the peer** | `127.0.0.1:19130` (userland relay) → peer `:19099` → `HELLO-FAR` |
| 3 | reconnect | relay killed, traffic stopped, recovered (pid 5286 → 5300) |

This is the strongest of the three: a `net.Server` → `net.connect` relay
carrying real bytes **between two distinct hosts**.

## REVERSE — 5/5

The product maps REVERSE onto an SSH remote forward
(`reverseToSshConfig()` → `buildSshCommand()`), so the probe runs the exact argv
that mapping produces:

```
ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
    -o StrictHostKeyChecking=accept-new -i <key> -o BatchMode=yes \
    -R 0.0.0.0:19140:127.0.0.1:19098 -p 22 probeuser@127.0.0.1
```

| # | assertion | evidence |
|---|---|---|
| 1 | origin serves `HELLO-XR` on 19098 | control |
| 2 | real sshd running | pid 4785 |
| 3 | public key installed in `authorized_keys` | throwaway key |
| 4 | **traffic crossed back** | `127.0.0.1:19140` (installed by `-R`) → tunnel → `127.0.0.1:19098` → `HELLO-XR` |
| 5 | reconnect | forward killed, exposed port stopped, recovered (pid 5521 → 5543) |

**Scope, stated precisely.** The sshd is on the same node as the client, so this
proves the product's REVERSE argv is accepted by a real sshd and that the
listener it installs delivers the intended service — it does **not** prove
cross-host reverse forwarding to a third machine. `GatewayPorts` is not enabled
here, and the probe says so in its output rather than implying a wider claim.
The cross-host variant needs a peer with an ssh client; no container has one
without an install, and the install was not approved.

---

## Three harness defects fixed while gathering this

**1. `set -u` killed the script on an unset variable.** `B` was read inside a
loop before its first assignment: `line 34: B: unbound variable`. Initialise
before the loop.

**2. A duplicated `-i` broke the reverse probe.** The emitter spliced
`-i <key>` into an argv that *already* contained `-i <keyPath>` — the builder
takes the key through `opts.keyPath`. Result: `ssh` read `-i` as a filename and
the key path as a hostname (`Could not resolve hostname /tmp/probe4/revkey`).
The emitter now asserts `-i` immediately precedes the placeholder. This is the
second argv-slot bug in this work, and the same shape: **positional surgery on
generated argv is where the harness breaks, not the product.**

**3. `ping` was used as a reachability probe.** It reported the two nodes
isolated. A TCP connect to the same address succeeded immediately. ICMP is
filtered in this network; a UDP/TCP reachability claim must be made with a
socket.

---

## Coverage: 8 of 9

| Method | Real binary on target OS |
|---|---|
| GOST | yes |
| FRP | yes (after the `allowPorts` fix) |
| XRAY | yes |
| BACKHAUL | yes |
| SSH | yes |
| DIRECT | yes — this session, across two nodes |
| PORT_FORWARD | yes — this session, across two nodes |
| REVERSE | yes — this session, same-node sshd |
| **XUI** | **no — metadata-only by design** |

XUI records the status of a 3x-ui panel and runs no tunnel binary on our nodes,
so there is no binary to execute. Its status comes from a real panel verification
instead. This one gap is by design rather than by environment, and it is recorded
as such — it is not a shortfall that a credential would close.
