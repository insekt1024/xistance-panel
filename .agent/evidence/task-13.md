# TASK-13 evidence — one-line version-pinned installer

**Status:** passed (local verification incl. the real artifact; no live VPS install yet)

## Changes

| File | Change |
| --- | --- |
| `scripts/release-install.sh` | New version-pinned, zero-build installer. |
| `scripts/test-release-installer.sh` | New focused test, 21 assertions. |
| `scripts/verify-artifact.ts` | Added a `verify` CLI; allowed `tunnels` as a top-level entry. |
| `scripts/bootstrap.sh` | Added `--release` / `--version` zero-build mode; source checkout now requires explicit `--source`. |
| `README.md` | Documents the pinned one-line command, dry run, and the source alternative. |

## The documented command

```bash
curl -fsSL https://raw.githubusercontent.com/insekt1024/xistance-panel/v1.2.0/scripts/bootstrap.sh \
  -o /tmp/xp-install.sh && sudo bash /tmp/xp-install.sh --release --version v1.2.0
```

`--version` is **mandatory**; there is no `latest` default, because an unpinned
install is not reproducible. A missing or non-semver version exits 2.

## Acceptance criteria → evidence

1. **Pins an explicit version, selects the correct architecture.** `--version` is
   required and validated against `^v\d+\.\d+\.\d+$`. `uname -m` maps
   `x86_64|amd64 → amd64` and `aarch64|arm64 → arm64`; anything else exits 3
   rather than guessing. Covered by "accepts an explicit --version", "refuses
   an unpinned version", "detects the host architecture", "rejects an
   unsupported architecture".
2. **Downloads and verifies, stages, preserves external mutable data, installs
   the service, checks readiness.** The order is enforced: download →
   **verify** → extract → deploy → activate → readiness. Mutable state stays in
   `$DATA_DIR` / `$ETC_DIR`; a systemd unit is written only when systemd exists;
   readiness polls `/api/health` 15×1s.
3. **Never runs `npm ci`, `npm install`, `next build`, or source compilation.**
   Asserted structurally with comments stripped (so the file's own prose saying
   it does *not* build cannot read as a violation). `bootstrap.sh` additionally
   *refuses* a source checkout without `--source`.
4. **Actionable nonzero errors.** Distinct exit codes: 2 usage/version, 3
   unsupported OS/arch, 4 missing runtime (Node < 22), 5 download, 6 checksum,
   7 staging/extraction, 8 activation, 9 readiness. Each message states the
   cause and the remedy.
5. **A successful install leaves the prior release recoverable.** The previous
   release is captured before activation, never deleted, and its path is printed
   on success along with the rollback command.

## Verified against the real artifact

Not only structural greps — the real `xistance-panel-v1.1.2-amd64.tar.gz` was run
through the exact CLI the installer invokes:

```
verified: xistance-panel-v1.1.2-amd64.tar.gz (sha256 8af3a965…)
VERIFY_REAL_EXIT=0
```

and the negatives: wrong architecture → exit 1, corrupted bytes → exit 1 with
"checksum verification failed … refusing to extract".

## The two most serious bugs found

### 1. The verify CLI exited 0 on a tampered artifact

`process.exitCode = 1` set from an async tsx entry point did not take effect;
the process finished with the default **0**. An installer gating extraction on
that status would have proceeded on a corrupted artifact. Worse, the *valid*
case also exited 1, so the bug was inconsistent and would have been easy to
misread.

Found by running the CLI directly rather than trusting the test suite, because a
`| head` pipeline masked the status. Fixed with an explicit `process.exit(0|1)`
in all four exit paths, and a regression test now asserts: valid → 0,
wrong-arch → non-zero, no-args → non-zero.

### 2. `tunnels/` was rejected as an unexpected top-level entry

The allowlist in TASK-12 omitted `tunnels`, which legitimately ships in the
artifact for backhaul/frp/gost/xray. This was only exposed by running the real
artifact; the synthetic fixtures never contained it. The allowlist was
corrected — not the artifact.

## Other fixes during this task

- Two invented variables in the first `bootstrap.sh` release branch
  (`REPO_SLUG_OVERRIDE`, `REPO_URL_SLUG`); replaced with a real `REPO_SLUG`.
- `--repo` previously set `REPO_URL`; it now sets the slug and derives the URL.
- The test matched the *comment* stating the script does not build, producing two
  false failures; the test now strips comments first.
- CLI guard in `verify-artifact.ts` so importing the module (as the tests do)
  does not execute the CLI.

## Verification commands and results

| Check | Result |
| --- | --- |
| `bash scripts/test-release-installer.sh` | `21 passed, 0 failed` |
| `bash scripts/test-release-layout.sh` | `35 passed, 0 failed` |
| `bash scripts/test-release-cutover.sh` | `19 passed, 0 failed` |
| all 6 TS release suites | pass |
| `bash -n` on all 10 shell scripts | all ok |
| real artifact via verify CLI | exit 0 |
| wrong arch / corrupted bytes | exit 1 (both) |
| `npm run version:check` | `✓ All 7 version files match 1.1.2` |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| release-script `tsc --noEmit` | exit 0 |
| `scripts/test-optimizations.ts` | `77 passed, 0 failed of 77` |

## Recorded gaps (not proven by this task)

1. **No live install has been run.** The download, systemd, and readiness paths
   have never executed on a real Ubuntu host. Only argument parsing, path
   planning, and verification are proven.
2. **`v1.2.0` does not exist yet.** The README documents the pinned command with
   `v1.2.0`, which is the intended release but is unpublished. A user copying it
   today gets a 404.
3. **Verification degrades to `sha256sum` when `npx` is unavailable.** That still
   refuses a tampered artifact, but the manifest agreement and archive-layout
   checks are skipped. The report says so honestly rather than claiming full
   verification. Worth revisiting: a standalone JS verifier would avoid needing
   npx on the host.
4. **The artifact's Prisma schema still needs `db push` after install.** The
   installer creates the env file and database URL but does not apply the
   migration; on the VPS this previously produced `table main.Tunnel does not
   exist`. This is the known reason the health check can fail on a first
   install, and it is not yet fixed here.
5. **Tunnel binaries (`backhaul`, `frp`, `gost`, `xray`) are not installed by
   this path.** The source installer does that; the release installer does not,
   so the nine tunnel methods are not yet covered by the zero-build path.

## Secret handling

No credential, token, or private key was written into the installer, the tests,
or this evidence. The generated `JWT_SECRET` is created at install time on the
target host and written only to `$ENV_FILE` with mode 600. VPS values remain
`[REDACTED]`.
