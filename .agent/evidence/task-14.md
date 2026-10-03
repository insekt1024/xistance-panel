# TASK-14 evidence — pinned-artifact update and rollback

**Status:** passed (local, sandboxed; no live VPS update has run)

## What changed

`scripts/update.sh` was a source rebuild. It ran `git fetch` + `git reset --hard`
on the server, then `npm ci` and `npm run build` — the exact heavy chain the
zero-build design exists to eliminate, and destructive to any uncommitted state
on the host.

It is now a pinned-artifact flow:

| Old behaviour | New behaviour |
| --- | --- |
| `git fetch` + `git reset --hard origin/$BRANCH` | nothing; a release artifact is installed |
| `npm ci` + `npm run build` on the VPS | nothing; CI produced the artifact |
| floating "latest branch" | pinned `--version`, no floating option at all |
| tar the source tree into a release | extract a verified, checksummed artifact |
| schema never migrated on update | migrations run from the staged release |
| no data backup | data tarball taken **before** any schema change |
| cutover, no rollback command | `--rollback` restores the previous release |

## Acceptance criteria

| Criterion | How it is met | Test |
| --- | --- | --- |
| Accepts a pinned version, never builds source | `--version` required; no git/npm/next invocation in the executable path | "does not run: git reset --hard / npm ci / npm run build / git fetch / next build" |
| Data backed up before migration or cutover | `take_backup` runs before extraction; an empty/unreadable tarball is treated as failure | "a backup is taken before migrating" |
| Migration/readiness failure leaves the previous release serving | both paths exit non-zero without activating | "a migration failure leaves the previous release active", "a readiness failure rolls back" |
| Success preserves data, switches atomically, reports old→new | data check + pointer check + output check | "existing data survives", "the new release becomes active", "reports both old and new versions" |
| Rollback selects the previous release without deleting data | `--rollback` activates `previous`, no `rm` of the data dir | "rollback activates the previous release", "rollback does not delete mutable data" |

`scripts/test-update-flow.sh`: **24 passed, 0 failed**.

## Real bugs found and fixed

1. **The archive was extracted beside the release, not into it.** The release
   tarball's root *is* the release tree, so `tar -C "$XT_RELEASES_DIR"` scattered
   files across the releases directory and no `1.1.0/` directory ever formed.
   Every update failed at "the release does not include apply-migrations.mjs".
   Now extracts into `$RELEASE_DIR`.
2. **A stub migration script made the migration-failure test vacuous.** The
   fixture wrote `// stage` as `apply-migrations.mjs`, which exits 0 no matter
   what SQL it is given — so the "migration fails" case *passed* by succeeding.
   The suite was green while proving nothing. The fixture now copies the real
   applier and admin scripts from the repo, and the invalid SQL is a genuine
   syntax error (`CREATE TABLE (;`). This was the most important fix in the
   task: a test that cannot fail is worse than no test.
3. **`node` could not resolve a POSIX path from the shell.** The applier is
   invoked as a native binary, and under MSYS/Git Bash a `/tmp/...` path is not
   resolvable. Added `native_path`, which is a **no-op on Linux** (no `cygpath`
   exists there) and converts only where needed.
4. **Fixture data files were not valid SQLite databases.** `app.db` was a text
   file, so any case that opened it failed for the wrong reason. The fixtures
   now use a real empty database and a separate marker file for the
   data-survival assertions.
5. **`npx` received a mangled path.** The verifier was called with an absolute
   MSYS path; now invoked from within the repo by relative path.

## Tests are non-vacuous (verified by mutation)

| Mutation | Result |
| --- | --- |
| `apply_migrations` failure gate removed | 22 passed, **2 failed** |
| readiness-failure rollback removed | 23 passed, **1 failed** |
| unmutated | 24 passed, 0 failed |

## Recorded gaps

1. **No live update has run on Linux/systemd.** Health probing, `systemctl`, and
   the real download path are exercised only through injected stand-ins
   (`XT_TEST_HEALTH_CMD`, `XT_TEST_RESTART_CMD`).
2. **Full artifact verification is skipped on a bare VPS** because
   `verify-artifact.ts` needs `tsx`. The checksum gate is still mandatory and
   enforced; the manifest/architecture/archive-safety checks are reported as
   unavailable rather than assumed to pass. Closing this needs a compiled
   verifier in the artifact (follow-up).
3. **Downloads are untested.** `resolve_archive`'s GitHub fetch has not been
   exercised, and no release is published yet, so there is nothing to fetch.
4. **No downgrade path.** `--version` will happily install an older release, but
   the migration applier only moves forward; a schema downgrade is not handled.
5. **Backup retention is unbounded** — nothing prunes old data tarballs.

## Gates

`test-update-flow` 24/24; `test-release-layout` 35/35; `test-release-cutover`
19/19; `test-release-installer` 23/23; `bash -n` on all shell scripts; version:check,
lint, typecheck all clean; optimization harness 77/77.
