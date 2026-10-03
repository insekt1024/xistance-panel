# TASK-75 — write-path proof on both required target OS versions

Date: 2026-09-30
Status: both target cells now green on a REAL application write
Follows: TASK-74 (root-owned `app.db` on first install)

## Why a permission bit is not a write

TASK-74's defect passed every check I had been running: the service was
`active`, `/api/health` returned 200, `/api/nodes` returned 401, and even
`su -s xistance -c "test -w /var/lib/xistance/app.db"` eventually returned YES
after the fix. But the *application's* write path had never actually been
exercised as the unprivileged service user.

So I ran a real `INSERT` through `node:sqlite` as `xistance`, against the same
`app.db` the app uses. On the 24.04.5 target it succeeded. On the **22.04.5**
target it failed outright:

```
Error: attempt to write a readonly database
    at file:////[eval1]:4:4
  code: 'ERR_SQLITE_ERROR', errcode: 8
```

while that host simultaneously reported `health=200 nodes=401 unit=active`.
`xtinst` was still running a **pre-fix** install — its `app.db` was
`root:root`. This is exactly the gap the write-path probe exists to close: the
22.04.5 cell would have been reported green on health endpoints alone, with
every write in the product failing.

## What was done

Reinstalled the current archive on `xtinst` (Ubuntu 22.04.5) with the fixed
installer, then re-probed both targets.

## Both required targets, current archive, current state

| | xt24 | xtinst |
|---|---|---|
| OS | 24.04.5 LTS (Noble Numbat) | 22.04.5 LTS (Jammy Jellyfish) |
| arch | amd64 | amd64 |
| PID 1 | systemd | systemd |
| Node | v22.23.3 | v22.23.3 |
| active release | `v1.2.0-20260930125344` | `v1.2.0-20260930132441` |
| UDP repair in running release | PRESENT | PRESENT |
| `app.db` owner | `xistance:xistance` | `xistance:xistance` |
| `test -w` as `xistance` | YES | YES |
| **real SQLite INSERT + readback** | `{"v":7}` OK | `{"v":7}` OK |
| `/api/health` | 200 | 200 |
| `/api/nodes` | 401 | 401 |
| unit | active | active (enabled) |
| readonly errors, last 3 min | 0 | 0 |
| `xt-rollback` | present | present |

Whole-journal readonly counts (20 on xt24, 5 on xtinst) are **historical**,
from the pre-fix installs. They are zero across the reinstall window, which is
the claim that matters.

### 22.04.5 install transcript (the reinstall that closed the cell)

```
→ Using the local artifact /tmp/xcurrent.tar.gz…
✓ Manifest taken from the artifact.
✓ Checksum verified (sha256sum).
→ Release v1.2.0 is already installed; deploying as v1.2.0-20260930132441.
→ Applying database migrations…
  migrations up to date (0 applied, 1 total)
✓ Systemd unit installed for xistance.
✓ Rollback helper installed at /usr/local/bin/xt-rollback
✓ Xistance Panel v1.2.0 is installed and healthy on port 8080.
```

Static assets referenced by `/login` (following the redirect), 22.04.5:
**12 referenced, all 200**. `/fa/login` 200, `/en/login` 200.

The installer shipped with **0 CR bytes** and `bash -n` clean, so the CRLF
total-outage class is excluded on both cells.

## Durable gate: `scripts/test-target-write-path.sh`

A target OS may only be reported green if the service user's real write path
works. The gate is registered in the runner's `ARGUMENT_TAKING` set (it takes
container names and cannot run in the portable aggregate), so the orphan check
stays strict rather than being loosened.

Non-vacuity, measured without a pipeline (`out=$(cmd); rc=$?`, because
`bash gate.sh | tail` reports tail's status):

| condition | verdict | real exit |
|---|---|---|
| both targets healthy | PASS, 10/10 | **0** |
| `app.db` chowned to root, health still 200, unit still active | **FAIL** — `✗ service user can write… PROBE_FAIL attempt to write a readonly database` | **1** |
| fixed installer re-run → `xistance:xistance` | PASS, 5/5 | **0** |
| container does not exist | **INCOMPLETE** — `⊘ container not found (not counted as a pass)` | **3** |

The broken case is the point: the read-side checks (systemd PID 1, unit active,
`/api/health` 200) all stayed **green** while the write check went red. That is
precisely the combination that let TASK-74's defect be reported as a passing
release on two required target OS versions.

## A bug in my own new gate, caught by the non-vacuity run

The first version counted readonly errors as
`journalctl … | grep -c "readonly database" || echo 0`. `grep -c` prints `0`
**and exits 1** when there are no matches, so the `|| echo 0` appended a second
line and the value became `"0\n0"`, which string-compares unequal to `"0"`. Both
targets failed a check that was actually true. Fixed by taking `head -1` and
coercing non-numeric to 0 instead of adding a fallback that duplicates grep's
own zero.

## The archive was not staled by the TASK-74 fix

Verified rather than assumed: the release archive contains **0** installer
files (it is payload-only; the installer is fetched from the tag). The
`release-install.sh` fix therefore does not require a rebuild, and
`dist/amd64/xistance-panel-v1.2.0-amd64.tar.gz` (`6c2be9cd…`, 40,921,390 bytes,
101-byte one-line sidecar) is still the current, verified artifact.

## Durable rule

After installing on a target, assert the **application's** write path as the
unprivileged service user, not the service's read path and not a permission
bit. A green health endpoint is a read; the defect class that matters here is a
write. `test -w` catches a wrong owner, but a real round trip through the same
engine the app uses is the only thing that catches a wrong *mode*, a read-only
mount, a stale file handle, or a WAL sidecar the service user cannot create.

## Remaining gaps (unchanged)

- Distinct-host REVERSE unproven; `GatewayPorts clientspecified` not applied —
  approval timed out three times now, not retried.
- Live post-fix password-reset run not executed — approval timed out. The
  doc-path defect is fixed and bound to a code-derived test.
- arm64: matrix cell now wired to a real arm64 runner and mutation-verified, but
  **no arm64 archive built** — requires a CI arm64 runner, unavailable on this
  x64 Windows host.
- Task JSON step flags remain 60/303 `pass: true`.
- No `v1.2.0` tag, commit, push, or public release exists.
