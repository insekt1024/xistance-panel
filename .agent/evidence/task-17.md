# TASK-17 evidence — install/update CLI regression tests

**Status:** passed (local fixtures; no real install has run)

## What changed

| File | Change |
| --- | --- |
| `scripts/test-cli-regression.sh` | **new.** 44 CLI regression tests driving the real scripts. |
| `scripts/release-install.sh` | Added `XT_FIXTURE=1`; root and curl checks are relaxed only in fixture mode; fixture mode refuses real system paths and skips every host mutation. |

## Fixture mode

`XT_FIXTURE=1` makes host mutation **structurally impossible** rather than
merely skipped:

- refuses to run as root (a test must never be able to write to real `/opt`);
- refuses `/opt`, `/etc`, `/var`, `/usr` for install/data/etc dirs;
- still *renders* the systemd unit (so a broken renderer is still caught) but
  never installs it;
- never creates the service account, never `chown`s, never restarts a service;
- the readiness probe is driven by `XT_TEST_HEALTH_CMD` so success and failure
  are both reachable without a live server.

Production validation is unchanged: every one of these relaxations is gated on
the fixture flag, and a real install still requires root.

## Coverage against the acceptance criteria

| Criterion | Tests |
| --- | --- |
| amd64/arm64 mapping, unsupported architecture rejected | `--arch amd64` and `arm64` accepted; `ppc64le`, `s390x`, `riscv64`, `mips` rejected **and** the rejection must explain why |
| pinned version, mirror, install dir, data dir, dry-run | missing `--version` refused; `latest` refused; non-semver refused; `--repo` changes the slug; `--dry-run` exits 0, activates nothing, extracts nothing |
| no `npm ci` / `npm install` / `next build` in the release path | 6 forbidden strings × 2 scripts = 12 tests, with comments stripped first so the files' own "we do not build" prose is not mistaken for a violation |
| missing checksum, malformed archive, failed readiness, rollback | no sidecar refused; wrong digest refused **and** explained; non-tar archive refused; failed readiness leaves the previous release active; `update --rollback` with no previous release refused and explained; missing archive refused |
| no host system changes | fixture mode refuses `/opt/xistance-probe`, and nothing is created there |

`scripts/test-cli-regression.sh`: **44 passed, 0 failed**.

## Non-vacuous (verified by mutation)

| Mutation | Result |
| --- | --- |
| fixture-mode `/opt` guard neutered | 43 passed, **1 failed** |
| unmutated | 44 passed, 0 failed |

## Bugs found and fixed in the installer while writing these tests

1. **Fixture mode could not be implemented as written.** The root check at the
   top of `release-install.sh` had no escape, so the CLI could not be driven
   without `sudo`. The check now exempts fixture mode *only*.
2. **`curl` was a hard prerequisite** even when the artifact was already staged
   locally and no download was needed. Now required only on a real install path.
3. **The first fixture guard I added was dead code** — it called `die` before
   `die` was defined, and sat after the dry-run early exit, so `--dry-run` with
   `/opt` sailed through and exited 0. Verified directly afterwards: the guard
   now exits 2 and creates nothing. This is a reminder that "the test passed"
   is not the same as "the guard ran" — the first mutation attempt also silently
   failed to match, which would have looked like a green result.

## Recorded gaps

1. **No successful end-to-end install is exercised here.** The stub artifacts
   cannot pass real verification, so the success path (download → verify →
   extract → migrate → activate) is covered by TASK-16's staged-artifact smoke
   test and TASK-13's static tests rather than by this CLI suite. Wiring a real
   artifact through the installer in fixture mode is the obvious follow-up.
2. **`--mirror` / `XT_MIRROR` is not directly asserted**, only indirectly via
   `--repo`. The URL construction is not compared against a known-good string.
3. **Fixture mode does not cover `install.sh`** (the source installer); only
   `release-install.sh` and `update.sh` are in scope here.
4. **Port/firewall and OS-support checks** are exercised only as far as dry-run
   reaches them; `check_os` is not asserted for a real unsupported distro.
5. **Windows/MSYS** only exercises the MSYS paths available here; the CI matrix
   on Ubuntu is the intended authority for the real behaviour.

## Gates

`test-cli-regression` 44/44; layout 35/35, cutover 19/19, installer 23/23, update
24/24, service-contract 24/24; `bash -n` on all shell scripts; 4 TS suites green;
version:check, lint, typecheck clean; harness 77/77.
