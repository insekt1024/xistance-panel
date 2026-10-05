# AGENTS.md, tunnel-core

Tunnel engine for 10 methods: BACKHAUL, FRP, GOST, ICMP, SSH, PORT_FORWARD, DIRECT, REVERSE, XRAY, XUI. 18 files under `src/`. Only dependency is `@xistance/types`.

## Modules

- `src/index.ts`, public barrel only. Export new modules here, no logic.
- `src/engine.ts`, `TunnelEngine.deploy/status/snapshot`, plus `start/stop/restart/remove`, `recentLogs/streamLogs`. `deploy` disposes the prior runtime, builds a plan, writes files, creates processes, then starts them.
- `src/config/*`, pure builders: `backhaul.ts`/`frp.ts` TOML, `gost.ts`/`direct.ts`/`ssh.ts` argv, `pingtunnel.ts` 0600 JSON (secrets never in argv), `reverse.ts` maps REVERSE to SSH remote-forward, `xray.ts` JSON, `xui.ts` panel URL and sync payload. No I/O, no runner calls.
- `src/process.ts`, `ProcessManager.create` picks the backend; `buildUnit`, `sanitizeUnitText`, `SystemdProcessHandle`, `ChildProcessHandle`.
- `src/runner.ts`, two transports: `LocalRunner` (execFile/spawn) and `RemoteRunner` (OpenSSH, sshpass for password nodes). `isLoopback` decides local vs remote.
- `src/forwarder.ts` (in-process TCP/UDP forwarders) and `src/forwarder-runner.ts` (standalone worker spawned by PORT_FORWARD plans).
- `src/binary.ts`, presence and checksum checks with install hints. `src/security.ts`, AES-256-GCM secrets plus scrypt passwords. `src/eventbus.ts`, in-process tunnel events for SSE/logs.

## Lifecycle and dispatch

- `buildPlan` dispatches per method: backhaul/frp write TOML and run binaries, gost/direct run `gost -L`, icmp writes a 0600 JSON per role and runs `pingtunnel -c`, ssh/reverse resolve `ssh` plus optional `autossh` via `systemBin`, port-forward runs the forwarder worker locally or `gost -L` remotely, xray writes `xray.json`, xui writes `xui.json` and plans zero processes.
- Process selection: local host with systemd gives `SystemdProcessHandle`, remote nodes always get `SystemdProcessHandle`, everything else gets `ChildProcessHandle`. `XT_FORCE_NODE=true` forces the child path.
- Units: `xt-<sanitized-id>-<role>.service`, id sanitized to `[A-Za-z0-9_-]` and capped at 200 chars. Unit files go under `<dataDir>/systemd/` and are written `0600`. Child logs go to `<dataDir>/logs/<id>.log`.

## Invariants

- Keep config builders pure and total for their method. Planner drops the leading `ssh`/`autossh`/`gost` token and substitutes the resolved binary path.
- New SSH/autossh extra args must pass `filterExtraArgs`: only `-o Key=Value` pairs on the allowlist with `[A-Za-z0-9._-]` values. Never add ProxyCommand, LocalCommand, IdentityFile, or similar.
- Unit text: `sanitizeUnitText` on descriptions, `shellQuote` on ExecStart argv, `systemdQuote` on `Environment=` values so CR/LF cannot inject directives.
- `RemoteRunner` omits `BatchMode=yes` for password auth (it breaks sshpass) and sets it otherwise. SSH passwords travel via `SSHPASS` env, never argv. Secrets at rest use `encryptSecret`, unit files stay `0600`.
- SSH plans set `AUTOSSH_GATETIME=0`, `AUTOSSH_POLL`, and `AUTOSSH_PATH` so autossh monitors from second one with the resolved ssh binary.
- `forwarder-runner.ts` stays Node-builtins-only (`node:fs/promises`, `node:net`, `node:dgram`) so it runs via `node --experimental-strip-types` on any node. It must parse `--rules`, print `XT_FORWARDER_READY`, and roll back bound listeners on failure.
- `EventBus.publish` must never let one subscriber break dispatch. Wrap listener calls in try/catch.

## Commands

```bash
npm run build --workspace @xistance/tunnel-core
npm run typecheck --workspace @xistance/tunnel-core
```

`dist/` is generated from `tsconfig.build.json`. Do not edit it.
