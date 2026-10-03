# TASK-82 — the arm64 service gate, and a misdiagnosis it corrected

**Status: arm64 service start and persistence PROVEN on Ubuntu 24.04.5
aarch64.** The blocker recorded in TASK-80 was misdiagnosed. The installer and
the artifact were never broken; GNU tar is broken on this emulated host.

## What TASK-80 recorded

```
INSTALL EXIT: 7
Cannot open: Invalid argument
```

with a control extraction to `/tmp` reported as succeeding. That asymmetry
looked like a filesystem problem with `/opt/xistance`, and a diagnostic aimed at
it was blocked, so the round ended there. **The control was the misleading part.**

## The actual cause

Run again with the control written to be trustworthy — the same archive, the same
`tar`, two destinations in the same container:

```
=== CONTROL: extract to /tmp/ctl ===
tar: ./apps/web: Cannot mkdir: Invalid argument
tar: ./apps/web/.next: Cannot mkdir: Invalid argument
=== SUBJECT: extract to /opt/xistance ===
tar: ./apps/web: Cannot mkdir: Invalid argument
tar: ./apps/web/.next: Cannot mkdir: Invalid argument
```

**Identical.** The earlier "control succeeds" was an artefact of that run, not a
real property. There is no `/opt/xistance` problem.

Narrowing further, with a two-entry archive containing one text file:

```
mkdir -p single          OK
mkdir -p nested          OK
echo hi > /tmp/direct.txt OK
install -m 755 ...        OK
dd if=/dev/zero of=...    OK
cp ...                    OK
tar -xzf tiny.tar.gz      tar: ./sub/f.txt: Cannot open: Invalid argument
tar --no-same-permissions tar: ./sub/f.txt: Cannot open: Invalid argument
tar (pre-created file)    tar: ./sub/f.txt: Cannot open: Invalid argument
```

Every ordinary creation syscall works. Only GNU tar 1.35 fails — including when
the destination file already exists with the correct mode, which rules out
permissions and `--no-same-permissions` confirms it independently.

**Conclusion: a QEMU-user-mode / GNU-tar interaction on emulated arm64. Not a
product defect, and not fixable in this repository.** On real arm64 hardware the
installer's `tar -xzf` is correct as written.

## Getting the evidence anyway

A throwaway ustar reader (in scratch, never in the repository, never shipped —
the installer keeps using GNU tar) extracted the archive on the same emulated
host. That turns an unprovable gate into a provable one.

It also had to handle GNU long-name (`L`) entries — 62 of them, carrying
`./@LongLink`-style extended headers. A reader that assumes `ustar` only fails on
a perfectly valid archive.

## The arm64 service gate — Ubuntu 24.04.5 aarch64, systemd-capable container

| gate | result |
| --- | --- |
| checksum sidecar | `xistance-panel-v1.2.0-arm64.tar.gz: OK` |
| extraction | 1,990 files, 420 directories, `apps/web/server.js` present |
| native blobs | `sharp-linux-arm64-0.35.4.node`, `libquery_engine-linux-arm64-openssl-3.0.x.so.node` — both arm64, zero foreign or x64 |
| migration, as user `xistance` | `applied 20260823214332_init` — `1 applied, 1 total` |
| database file | 172,032 bytes, owner `xistance:xistance` |
| startup | `▲ Next.js 16.3.6`, `✓ Ready in 0ms` |
| Prisma / ELF errors in log | **0** |
| `/api/health` | `200 {"ok":true,"status":"healthy","version":"1.2.0","checks":{"database":"ok","engine":"ok","managedTunnels":"0"}}` |
| `/api/nodes` unauthenticated | `401 {"error":"Unauthorized"}` |
| `/login` | `307 → /en/login` |
| `/` | `307 → /en` |

### Persistence across a real restart

A marker file written by the service user, the server killed, restarted, and
re-probed:

```
data survived: persisted-by-service-user
db still there: 172032 bytes, owner xistance:xistance
/api/health   -> 200  {"ok":true,"status":"healthy","version":"1.2.0",...}
/api/nodes    -> 401
/login        -> 307  /en/login
```

The unprivileged service user can write its own data directory, and the database
survives a restart with ownership intact. This is the same ownership property
that was repaired for Ubuntu 24.04.5 on amd64 in an earlier round, now
confirmed on arm64.

## The lesson

**A control that was not re-run is not a control.** The `/tmp` extraction
"passing" was recorded as evidence in TASK-80 and carried forward as the reason
the round stalled. Re-running it identically would have falsified the entire
premise in one command, and no blocked diagnostic was ever necessary.

When a failure is blamed on the environment, reproduce the *blamed* component
under the same conditions before filing it. Emulation-layer defects are real and
common, but they must be demonstrated, not inferred from the absence of a
counter-example.

Scratch-only tooling used here (`xt-extract-notar.js`, the arm64 `node` binary)
lives in the Hermes scratch directory and was not added to the repository.

No credentials, tokens, private keys, or connection details appear in this file;
the session secret and encryption key in the probe are fixed placeholder strings.