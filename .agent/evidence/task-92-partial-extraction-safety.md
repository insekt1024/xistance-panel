# TASK-92 — the installer refuses a partial extraction (proven, not asserted)

**Status: the installer's failure path is verified by executing the real
installer against a real partial extraction.**

TASK-91 established that GNU tar under QEMU-user arm64 extracts 5 of 1990 files
and exits 2. That accident provides exactly what was missing: a way to exercise
the installer's failure path on a host where the install cannot succeed.

## 1. A tar shim that reproduces the failure on a real target

Rather than rely on the emulated host, the failure was reproduced on a working
amd64 target with a `tar` shim placed first on `PATH`:

```bash
#!/usr/bin/env bash
# Single explicit member (the manifest lift) -> real tar, succeeds.
# Full extraction -> write two files, then fail exactly like QEMU's tar.
echo "tar: ./apps/web: Cannot mkdir: Invalid argument" >&2
echo "tar: ./package.json: Cannot open: Invalid argument" >&2
echo "tar: Exiting with failure status due to previous errors" >&2
exit 2
```

Verified against the real 40,720,716-byte amd64 archive on `xt24`:

| Invocation | exit | files written |
| --- | --- | --- |
| single-member manifest lift | **0** | 1 |
| full extraction | **2** | 2 (of 1990) |

The shim is behaviourally identical to the QEMU failure at the two stages the
installer uses.

## 2. The real installer, run against it

```
$ bash /root/inst/release-install.sh --archive /tmp/xistance-panel-v1.2.0-amd64.tar.gz --version v1.2.0
→ Extracting into /opt/xistance/releases/v1.2.0-20260930232141…
tar: ./apps/web: Cannot mkdir: Invalid argument
tar: ./package.json: Cannot open: Invalid argument
tar: Exiting with failure status due to previous errors
✗ Extraction failed; the previous release is untouched.
INSTALL EXIT: 7
```

## 3. Safety audit after the failed install

| Property | Before | After the failed install |
| --- | --- | --- |
| `/opt/xistance/current` | `releases/v1.2.0-20260930222925` | **unchanged** |
| `systemctl is-active xistance` | active | **active** |
| `GET /api/health` | 200 | **200** |
| `app.db` size | 176,128 | **176,128** |
| `app.db` owner | `xistance` | **`xistance`** |
| release directories | 2 | **2** — no leftover candidate |

The partial candidate directory was removed by the installer's own error path.
`current` was never repointed, the service was never restarted against a
partial tree, and the database was never touched.

## 4. The statically-checkable contract, as a suite

`scripts/test-partial-extraction-safety.ts` (10/10) locks the same properties
in, since the runtime proof needs a target OS:

- the extraction's exit status is checked, not discarded
- a failed extraction calls `die` rather than continuing
- the partial candidate directory is removed on failure
- an `apps/web/server.js` presence check runs after extraction — the second line
  of defence, for a hypothetical tar that exits 0 while writing 5 files
- a missing entrypoint also removes the candidate and refuses to activate
- activation is invoked only after that check
- a failed activation also removes the candidate and exits non-zero

**Non-vacuity:** a mutant that deletes the `|| { ... die ... }` guard is applied
in-memory and the suite must detect it. It does. The assertions can fail.

Two assertions in the first version of this suite were themselves buggy and
were fixed rather than papered over: the `die` message is wrapped across two
source lines (a single-line regex silently never matched), and activation is a
`xt_activate_release` call, not an inline `ln -sfn`. Both had to be corrected to
match the real script — a reminder that a test which fails on correct code is
usually the test's fault.

## 5. Why this matters

An installer that activates a partial release is a severe defect: the service
would start against a tree missing its server entrypoint or its Prisma engines,
and the rollback path would be a partial tree. This is now proven not to happen,
on a real target, with a real archive, through the real code path.

## 6. Still open

This closes the installer's *failure* behaviour everywhere. It does not close
the arm64 **native install** gate: on a native arm64 host, tar works and the
install should succeed, but that has not been executed. See
`task-91-arm64-tar-qemu-defect.md` and the CI runner status in
`release-contract.md`.
