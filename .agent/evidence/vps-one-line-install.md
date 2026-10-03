# Real one-line install on the VPS — three production bugs found and fixed

**Status:** the installer now completes end-to-end on Ubuntu 24.04.1 and the
panel runs under systemd as an unprivileged user.

Every bug below was found by running the real script on the real host. None was
visible to any local test suite, because the local suites never handed a unit to
systemd and never executed the script under a POSIX environment.

---

## Bug 1 — every shell script shipped with CRLF line endings

`scripts/release-install.sh` could not run on Linux at all:

```
/root/xistance-test/release-install.sh: line 18: set: pipefail\r: invalid option name
/root/xistance-test/release-install.sh: line 19: $'\r': command not found
/root/xistance-test/release-install.sh: line 37: syntax error near unexpected token `$'{\r''
```

`.gitattributes` already declares `*.sh text eol=lf`, so a clean checkout is
correct; the **working tree had drifted** from that attribute. Six files were
affected, including `install.sh`, `bootstrap.sh`, `update.sh`,
`test-update-flow.sh` and `apply-migrations.mjs` — the migration applier that
runs on the target host.

This is a total outage of the install path, and it survived 17 passing tasks.

**Fix:** converted the affected files to LF, and added
`scripts/test-line-endings.sh` (54 assertions) so it cannot recur. The new test
also proves it is non-vacuous by creating a deliberately CRLF file and asserting
the check flags it.

## Bug 2 — the installer could only download from GitHub

With no GitHub release existing yet, and for any air-gapped host, the installer
had no way to run at all. Added `--archive <FILE>`, which installs a
pre-downloaded artifact and reads the manifest from inside it. The checksum
sidecar is now **mandatory in every mode** — previously a missing sidecar
silently degraded to an unverified install.

## Bug 3 — `check_os` overwrote the release version (silent)

The plan printed:

```
→ Installing Xistance Panel 24.04.1 LTS (Noble Numbat) (amd64)
  version : 24.04.1 LTS (Noble Numbat)
  release dir : /opt/xistance/releases/24.04.1 LTS (Noble Numbat)
```

`check_os` sourced `/etc/os-release`, which defines a variable literally named
`VERSION`, clobbering the release tag. Release paths would have been built from
the OS version. Now read through a subshell so nothing leaks into the script's
namespace. Two regression assertions added.

## Bug 4 — the systemd unit was fatally invalid (the serious one)

`release-install.sh` reported success and health, and **the panel answered
correctly** — but systemd had never started anything. A stale process from an
earlier manual boot was answering on the port, which made a broken install look
perfect.

```
/etc/systemd/system/xistance.service:9: EnvironmentFile= path is not absolute, ignoring: "/etc/xistance/xistance.env"
/etc/systemd/system/xistance.service:12: WorkingDirectory= path is not absolute: "/opt/xistance/current"
xistance.service: Unit configuration has fatal error, unit will not be started.
```

Cause: my own TASK-15 hardening quoted these two directives. systemd does **not**
strip quotes in `EnvironmentFile` and `WorkingDirectory`, so quoting made the
path non-absolute and systemd rejected the unit. Only `ExecStart` is an argv
list and therefore the only directive that takes quotes.

Had this shipped, every host would have shown a healthy panel with no working
service — and the failure would only appear at reboot, when nothing would
start.

**Fix:** those two directives are emitted unquoted. `test-service-contract.sh`
now asserts the unquoted form and runs `systemd-analyze verify` when available
(26 assertions).

---

## Verified after the fixes

| Check | Result |
| --- | --- |
| Installer exit | success, "installed and healthy on port 8082" |
| `systemctl is-active` | `active` |
| `systemctl is-enabled` | `enabled` |
| Process user | **`xistance`** (not root) |
| RSS | 117 MB |
| `/api/health` | `{"ok":true,"status":"healthy","database":"ok","engine":"ok"}` |
| `/en/login`, `/fa/login` | `200` |
| `/login` | 307 → `/en/login` → 200, terminates in 1 hop |
| `/` | 307 → `/en` |
| Static assets | JS chunks served, `application/javascript` |
| `systemd-analyze verify` | clean |
| Migrations | "up to date (0 applied, 1 total)" |
| Admin | "already exists; not modified" (idempotent) |
| Rollback hint | prints the retained previous release |

The install is genuinely idempotent: the second run refused to overwrite
`v1.1.2`, deployed as `v1.1.2-20260926015535`, kept the old release, and printed
a rollback command.

## Still open

- The `TypeError: Cannot destructure property 'locale'` seen once in the journal
  came from the stale root process mid-activation, not from the installed
  service. It has not reproduced under systemd and is not yet explained.
- `xt_activate_release` rollback is unit-tested locally but has not been
  exercised on the host.
- Nine-method tunnel lifecycle remains untested on this host.

**18/73 tasks passed. TASK-73 now has live proof.**
