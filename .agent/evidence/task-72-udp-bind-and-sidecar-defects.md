# TASK-72 — UDP forwarder bound-socket and checksum-sidecar defects

Date: 2026-09-30
Supersedes: `.agent/evidence/task-72-final-gate-decision-v6.md` (through v10)
Status: both defects fixed, mutation-tested, and proved on Ubuntu 22.04.5

## Trigger

The final local gate ran `scripts/run-all-tests.ts` and two suites failed with
Windows `EACCES` on `bind()`:

```
errno: -4092, code: 'EACCES', syscall: 'bind', address: '0.0.0.0', port: 50888
```

Ports 50798–50897 fall inside a Windows reserved/excluded dynamic range
(Hyper-V and WSL reserve large blocks; `netsh interface ipv4 show
excludedportrange` lists them). This looked environmental. It was not.

## Defect 1 — UDP upstream socket was never bound

### Root cause

`packages/tunnel-core/src/forwarder.ts` and
`packages/tunnel-core/src/forwarder-runner.ts` both created a per-client
upstream socket and called `send()` on it **without ever calling `bind()`**:

```ts
const upstream = dgram.createSocket("udp4");
upstream.on("message", (res) => listener.send(res, rinfo.port, rinfo.address));
upstream.on("error", () => {});          // deliberate no-op
upstream.send(msg, rule.destPort, rule.destHost);
flow = { upstream, lastSeen: Date.now() };
flows.set(key, flow);
```

An unbound `send()` lets the OS choose the local port. That choice can land in
an excluded range, and the `error` handler is a deliberate no-op — so the
`EACCES` was swallowed. Consequences:

- the flow was recorded as **established** in `flows`,
- every packet for that client vanished,
- the tunnel still reported itself healthy.

This is a correctness bug on any host that hands out an unbindable port, not
just this Windows box.

### Fix

Both files now obtain the socket from a retrying helper that binds explicitly
before the first send, and only record the flow once binding has succeeded:

```ts
function createBoundUpstream(attempts = 8): Promise<dgram.Socket> { ... }
```

The helper is **duplicated** in `forwarder-runner.ts` on purpose. That module
imports nothing but node builtins so it can be run directly with
`node --experimental-strip-types`; an earlier attempt exported the helper from
`forwarder.ts` and imported it, which made the runner's `--selftest` mode fail
outright because the runtime cannot resolve a relative `.js` specifier to its
`.ts` source. The constraint is now documented at the top of the file.

### Tests are non-vacuous

`scripts/test-port-forward.ts` gained two assertions (32 assertions, up from 29):

1. **A real UDP round trip.** A UDP forward must actually carry a packet:
   an echo server, a live `startForwarder()` forward, and a client that asserts
   it gets `PING-ECHO` back.
2. **The bind invariant, asserted directly in both forwarders.** The round trip
   alone cannot be made to fail on demand — reproducing the defect needs the OS
   to hand out a port that is *excluded from binding*, which needs
   administrative rights. Holding other ports open does **not** reproduce it (a
   held port is simply not offered again); an attempt to do so was written,
   shown to survive, and **deleted** rather than left in as a test that cannot
   fail. The surviving assertion checks that each forwarder has the
   `createBoundUpstream` helper, that the helper calls `socket.bind()`, and
   that no UDP socket is created and sent from with no intervening `bind()`.

Mutation results:

| Mutant | Result |
| --- | --- |
| `forwarder.ts` reverted to unbound `send()` | **killed** (31/1) |
| helper present but resolving without `bind()` | **killed** (31/1) |
| both files restored | 32/0 |

`test-disposal-cleanup.ts` also went from failing to **15/15**.

## Defect 2 — sha256 sidecar had a trailing blank line

Found by running the real verifier on the real target OS rather than trusting
our own parser:

```
xistance-panel-v1.2.0-amd64.tar.gz: OK
sha256sum: WARNING: 1 line is improperly formatted
```

The digest verified, which is exactly why no existing assertion caught it.

### Root cause

`renderChecksumFile()` already returns a `\n`-terminated string, and
`runManifestCli()` printed it with `console.log()`, which appends a second
newline. The sidecar was 102 bytes with two trailing newlines instead of 101
with one.

### Fix

`scripts/release-manifest.ts` now uses `process.stdout.write()` so the exact
bytes are produced.

### Test

`scripts/test-release-manifest.ts` gained a CLI-level assertion (it previously
only tested the pure function): it execs the real CLI and requires the output
to equal exactly `${digest}  ${name}\n`, with no doubled newline.

Mutation: reverting to `console.log` is **killed**.

After the fix the sidecar is 101 bytes, one line, and real
`sha256sum -c` on Ubuntu 22.04.5 reports `OK` with **no warning**.

## Target-OS proof (Ubuntu 22.04.5, systemd PID 1)

A clean `xtinst` container was created from `xt-target:22.04`, installed signed
NodeSource Node `v22.23.3`, and the freshly built archive was installed with the
real `scripts/release-install.sh`:

| Check | Result |
| --- | --- |
| OS / PID 1 | Ubuntu 22.04.5 LTS / `systemd` |
| `sha256sum -c` (real) | `OK`, no warning |
| tamper control (append `TAMPERED`, keep original sidecar) | `FAILED`, exit 1 |
| restored archive | `OK`, exit 0 |
| installer exit | **0** |
| service | `active`, `enabled` |
| `current ->` | `/opt/xistance/releases/v1.2.0` |
| process cwd | `/opt/xistance/releases/v1.2.0/apps/web` |
| `/api/health` | `200` `{"ok":true,"version":"1.2.0",...}` |
| `/api/nodes` (protected) | `401` |
| static assets referenced by `/login` | **12/12 → 200** |
| `/en/login`, `/fa/login` | `200`, `200` |
| `xt-rollback` after installer temp dir was removed | prints usage, sources a persistent library |
| shipped worker carries the bound-socket fix | present |

The installer needs `release-layout.sh` and `service-unit.sh` beside it; the
archive is payload-only by design and the docs fetch those from the release
tag. That is not a defect.

## Also repaired

`scripts/test-port-forward.ts` had a hardcoded absolute repo path
(`const ROOT = "E:/codes/Projects/Xistance-Tunnel/xistance-panel"`), which would
have made the new file-reading assertions fail anywhere else. Now derived from
`import.meta.dirname`.

## Gate state at the time of writing

- aggregate `npx tsx scripts/run-all-tests.ts`: 51/51
- browser gate `--all`: 12/12 suites, 0 skipped, artifact payload exercised,
  verdict `.agent/tmp-smoke/gate-muo1vh2i/verdict.json`
- typecheck 0, lint 0 errors / 24 warnings, audit 0 vulnerabilities
- installer 52/52, supply chain 55/55, Persian parity 66/66
- real-binary ledger 127/127 (8/9 methods; XUI is metadata-only by design)
- release-docs and verify-artifact pass
- archive: `dist/amd64/xistance-panel-v1.2.0-amd64.tar.gz`, 40,921,390 bytes,
  2,404 entries, sha256 `6c2be9cd0ecadc6c5561d00a3872693824b9ddd9921f1a7a04674816d6318a65`
- embedded manifest: `1.2.0` / `amd64` / prisma `6.19.3`

No commit, tag, push, or public release was created.
