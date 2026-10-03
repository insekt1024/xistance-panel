# TASK-100 — the arm64 installer completes when `tar` works

**Status: the installer's arm64 code path is proven end to end. The only thing
that ever blocked it was the emulated host's `tar`.**

TASK-91 root-caused the arm64 install failure as GNU tar 1.35 under QEMU-user
arm64. That diagnosis implied a fix I had not yet tried: **give the installer a
working `tar`**. `bsdtar` (libarchive 3.7.2) is packaged for Ubuntu arm64 and is a
completely different implementation.

```
bsdtar -xzf <the real arm64 archive>   ->  exit 0, 1988 files, 1 arm64 engine
```

## The install

A three-line shim putting `bsdtar` first on `PATH` as `tar`, so the installer
runs **unmodified**:

```sh
#!/bin/sh
exec /usr/bin/bsdtar "$@"
```

```
tar resolves to: /opt/realtar/tar -> bsdtar 3.7.2 - libarchive 3.7.2 …
INSTALL EXIT: 0
    ✓ Systemd unit installed for xistance.
    ✓ Rollback helper installed at /usr/local/bin/xt-rollback
    → Activating v1.2.0…
    ✓ Xistance Panel v1.2.0 is installed and healthy on port 8080.
```

## Installed state — aarch64, systemd as PID 1

| property | value |
| --- | --- |
| `uname -m` | `aarch64` |
| PID 1 | `systemd` |
| `/opt/xistance/current` | `/opt/xistance/releases/v1.2.0` |
| `systemctl is-active` / `is-enabled` | active / enabled |
| unit file | `/etc/systemd/system/xistance.service` |
| env file | `-rw------- root` (root-only, no secrets world-readable) |
| rollback tool | `/usr/local/bin/xt-rollback` |
| `GET /api/health` | 200 |
| `GET /api/nodes` (unauthenticated) | 401 |
| `POST /api/auth/login` (unauthenticated) | 400 |
| `app.db` | 172,032 bytes, owned by `xistance` |

Every element the amd64 installs were checked for. The arm64 install is not a
subset of the amd64 evidence — it is the same installer, on a different
architecture, producing the same contract.

## Write persistence through the installed release

```
1. write   : WROTE=c8691dc6-6e50-4bd8-a9d0-856f0cc2e574 BEFORE=0 AFTER=1
2. kill    : systemctl kill -s SIGKILL xistance   (MainPID 1170)
             health after kill: down
3. restart : health HTTP 200   service active
4. read    : NODES=1
             NODE=c8691dc6-6e50-4bd8-a9d0-856f0cc2e574:arm64-persist-…:203.0.113.9
```

Same UUID before and after a SIGKILL of the systemd-managed service, with the
write performed as the unprivileged `xistance` user. The data is durable and the
service user can write it, on arm64, through the real install.

## What this closes, and what it does not

**Closed:** the arm64 **installer code path** — archive verification, extraction,
migration, admin seeding, systemd unit, activation, rollback tooling, and
authenticated API behaviour. Previously the only arm64 evidence came from a
hand-extracted tree, which proved the payload and not the installer.

**Still open:**

1. **Native arm64 execution.** Everything above runs under QEMU-user. The
   shimmed `tar` is a stand-in for a native one; a native host has a working GNU
   tar and needs no shim, but that path remains unexecuted.
2. **The `ubuntu-24.04-arm` CI release cell has never run.**

The distinction matters and is the reason this is TASK-100 rather than "arm64
done": the installer's logic is now proven on arm64, but under emulation. A
native runner is still the only thing that closes the gate honestly.

## Note on the shim

The shim is a **host workaround, not a product change**. Nothing in
`release-install.sh` was modified, and nothing shipped depends on `bsdtar`. Its
sole purpose was to give the unmodified installer a `tar` that functions on this
emulated host, so the installer's own logic could be exercised. Claiming the
native install is proven on the strength of a shimmed `tar` would be exactly the
kind of unfalsifiable claim this evidence chain has been built to eliminate.
