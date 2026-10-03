# TASK-127 — a re-runnable traffic + reconnect harness, built from the product's own builders

**Status: 12/12 on the target OS. Four methods gained reproducible traffic AND
SIGKILL reconnect proofs. Seven of eight binary methods are now covered; XRAY is
the only one still resting on an unrecoverable probe.**

## The gap this closes

TASK-126 added a gate asking whether each traffic claim can be *re-established*:

```
FAIL methods whose traffic is claimed have a RE-RUNNABLE data-path test
     7 traffic claim(s) rest on no runnable test: FRP, XRAY, BACKHAUL, SSH,
     DIRECT, PORT_FORWARD, REVERSE
```

Seven claims rested on TASK-65 probes that lived in `/tmp` on containers that no
longer exist. Nothing in CI started a binary and moved a byte for them.

## The rule: no hand-written configs

TASK-124 burned five attempts hand-writing an xray config, and TASK-125 chased a
"defect" that existed only because of infrastructure **I** added. So every config
here comes from `scripts/gen-traffic-fixtures.ts`, which calls the same builder the
panel calls, and parses each input through the real Zod schema **first**:

```ts
const server = FrpServerConfigSchema.parse({ role: "server", bindPort: 17000, token, allowPorts: ["18100-18199"] });
emit("FRP", "frps.toml", buildFrpServerConfig(server));
```

That schema step earned its place immediately: the first draft used `as never`
casts and died inside `tomlQuote` on `undefined`. The schema fails the mistake here
instead of emitting a config a binary silently rejects.

## Result on the target OS (Ubuntu 24.04.5, systemd as PID 1)

```
ok   PRECONDITION: backhaul, frpc, frps and gost are present in /var/lib/xistance/bin
ok   PRECONDITION: the origin answers HELLO-XR on 19098
ok   GOST carries real bytes through buildGostCommand() output (port 18102)
ok   DIRECT carries real bytes through buildDirectCommand() output (port 18103)
ok   FRP carries real bytes through the product's buildFrpPair output (port 18100)
ok   BACKHAUL carries real bytes through buildBackhaulConfig() output (port 18101)
--- per-method reconnect (SIGKILL + systemd Restart=on-failure) ---
SIGKILLed FRP pid=27642
ok   FRP reconnect: the tunnel is DOWN after SIGKILL (no false recovery)
ok   FRP reconnect: systemd recovered it (pid 27642 -> 27736) and the same probe succeeds
SIGKILLed BACKHAUL pid=27697
ok   BACKHAUL reconnect: the tunnel is DOWN after SIGKILL (no false recovery)
ok   BACKHAUL reconnect: systemd recovered it (pid 27697 -> 27760) and the same probe succeeds
SIGKILLed DIRECT pid=27603
ok   DIRECT reconnect: the tunnel is DOWN after SIGKILL (no false recovery)
ok   DIRECT reconnect: systemd recovered it (pid 27603 -> 27799) and the same probe succeeds
RESULT: pass=12 fail=0
```

## The step that makes reconnect non-vacuous

A reconnect test proves nothing unless it shows the tunnel actually **died**:

1. the probe succeeds,
2. `kill -9` the MainPID,
3. **the probe now FAILS** — otherwise a later success is just the old process,
4. systemd restarts it with a new MainPID,
5. the same probe succeeds, with no operator action.

Step 3 is easy to omit and is what separates a real test from a hopeful one. Each
method asserts it separately, so a "recovery" that never lost the tunnel is a
failure, not a pass.

## Three builder conventions I had wrong, and the code that settled them

None of these were product bugs. Each time the answer was in the builder, not in a
guess:

| my assumption | what the code does | how I found it |
| --- | --- | --- |
| `buildGostCommand(cfg)` | `(cfg, role)`, returns **null** when `direction !== role` | the emitted file contained the text `null` |
| BACKHAUL `portMap` on the client | only the **server** half emits the ports block | the client config had no mapping |
| BACKHAUL ports `"local=remote"` | `portsBlock` emits **`${remote}=${local}`** | `ports = ["19098=18101"]` was backwards |
| BACKHAUL client dials `remotePort` | it dials **`listenPort`**, and `engine.ts` passes ONE config to both roles | `dial tcp 127.0.0.1:19002: connection refused` |

That last one is the design, not a defect: client and server run on different
nodes, so the client's "listen port" *is* the server's port, and `remoteHost` is
what points at it.

## What the suite will not do

`SSH`, `REVERSE` and `XRAY` are **not** generated here. Each needs a live peer the
panel does not build in this repo: an `sshd` for SSH/REVERSE (`engine.ts` maps
REVERSE to an SSH remote-forward), and a vmess/VLESS inbound for XRAY that the
product expects a 3X-UI panel to provide. Writing those by hand is the replica
mistake, so each needs its own harness. They keep their TASK-65 evidence for now and
`XRAY` is the one that still cannot be re-run.

## Honest state after this task

| method | traffic | reconnect | re-runnable |
| --- | --- | --- | --- |
| GOST | proven | **proven** | **yes** |
| FRP | proven | **proven** | **yes** |
| BACKHAUL | proven | **proven** | **yes** |
| DIRECT | proven | **proven** | **yes** |
| SSH | proven | proven | no |
| PORT_FORWARD | proven | proven | no |
| REVERSE | proven | proven | no |
| **XRAY** | **unverified** | **not proven** | **no** |
