# TASK-38 — Backup and restore verification path

**Status: passed.** 34/34 in `scripts/test-backup-restore.sh`, with the
pre-existing update, installer, and service-contract suites re-run as
regression (24/24, 23/23, 26/26).

## What changed

| File | Change |
|---|---|
| `scripts/lib/backup-lib.sh` | **New.** Shared create / verify / restore helpers with manifest, checksum, and path-traversal refusal |
| `scripts/backup.sh` | Now sources the library; gains `--verify` and `--restore`; captures data **and** config |
| `scripts/update.sh` | `take_backup` delegates to the library; `xt_backup_require` gates the cutover |
| `scripts/test-backup-restore.sh` | **New.** 34 assertions |
| `scripts/test-update-flow.sh` | `bad()` now prints its evidence argument (it was silently dropped) |
| `README.md` | Documents the pinned one-line install (`--release --version`) |

## Acceptance criteria

**AC1 — required content, documented exclusions.**
`the config directory is included`, `the encryption key material file is
included`, `the database directory is included`, `transient logs are excluded`,
`the exclusions are documented in the script`. The exclude list is a named
constant (`XT_BACKUP_EXCLUDES_DEFAULT`) with a comment per pattern, not a set of
buried tar flags — an operator reading a backup must be able to know what is
*not* in it.

**AC2 — checkpointing, verifiable checksum.**
`a checksum sidecar is written`, `the recorded checksum matches`, `the archive
is non-empty and readable`, `a per-file manifest is included`, and the
behavioural pair below.

**AC3 — validation, permissions, restore into a fixture.**
`a restore into a temporary fixture succeeds`, `every file is reproduced`,
`restored content matches the source byte for byte`,
`an absolute path is refused`, `a parent-directory escape is refused`,
`an escaping symlink is refused`, `no refused archive wrote outside its
destination`. Restore extracts into a sibling temp directory and only moves it
into place after the manifest check passes, so a failed restore cannot leave a
half-written destination.

**AC4 — update/rollback verifies the backup first.**
`a clean update run succeeds`, `update.sh takes a backup with a checksum before
migrating`, `the backup update.sh took verifies on its own`, `the backup was
taken before the release changed` (asserted by finding the data *inside* the
archive), `update.sh refuses when the backup cannot be created`, `update.sh
refuses when the backup does not verify`, `the active release is unchanged when
the backup does not verify`.

**AC5 — success, missing/corrupt, traversal.**
Covered by the three groups above, plus `a missing archive is refused`, `a
truncated archive is refused`, `a mismatched checksum is refused`, `an archive
with no checksum sidecar is refused`, `a tampered archive is not restored`.

## Three production bugs the tests found

**1. A checkpoint that silently did nothing.** The original code ran
`PRAGMA wal_checkpoint(TRUNCATE)` and moved on. A checkpoint only merges the
log when no *other* connection is reading it, and reports that as `busy` — and
a running panel always has one open. So the guarantee held only when the
service was stopped, which is exactly when nobody needs it. Now it checks
`busy === 0 && log === 0` and, when busy, falls back to `VACUUM INTO`, which
has SQLite itself write a fully merged copy and rename it over the original.
No exclusive lock required, so it works with the service running.

**2. A library default that overrode its caller.** `backup-lib.sh` opened with
`: "${XT_BACKUP_DIR:=/var/backups/xistance}"`. `update.sh` sourced the library
*after* computing its own default, so backups landed in `/var/backups/xistance`
while the rest of the release layout used the install root. The default is now
unset, and each caller sets what it wants.

**3. A confirmation message on a machine-read channel.** `xt_backup_verify`
prints `Backup verified: …` to stdout, and `take_backup` runs inside
`$( )` capturing a *path*. The captured value was `Backup verified: /path`, so
every later `-f` test on it failed for a reason that looked unrelated. Human
messages now go to stderr; stdout carries only data.

## The checkpoint test was vacuous, and the fix is the interesting part

The first version of the SQLite check opened the database, wrote a row, and
closed it. **Removing the checkpoint entirely still passed** — closing
flushes the log, so the row was already in the `.db` file and the test could
not tell the difference. I confirmed the mutant survived, then rewrote the
test to leave the log genuinely unmerged: a separate node process opens the
database in WAL mode, inserts, and **keeps the connection open**. The log file
is asserted to exist before the backup, the archive is asserted *not* to
contain it, and the restored database must report both rows.

Against the re-applied mutant that test now fails with `rows=1 (expected 2)`.
It is a real check.

## Two platform limits, stated rather than faked

- **File modes.** `chmod 600` is a no-op on this Windows/MSYS filesystem — the
  file reads 644 before any backup runs. The test therefore asserts exact 0600
  where the bit can exist, and asserts *consistency* (archive mode == source
  mode == restored mode) here, with the substitution named in the output. I did
  not fake a pass.
- **Native paths.** `node` cannot resolve a POSIX path from this shell, so both
  the database *and* the generated holder script are passed through `cygpath`.
  Missing that produced `Cannot find module 'E:\c\Users\…'` — a module-load
  error that reads like "no sqlite available" and silently downgraded the check
  to a skip. The skip message now distinguishes the two causes.

## Verification

```
npx tsc --noEmit -p apps/web/tsconfig.json      →  0
npx eslint scripts/                             →  0 errors
TURBO_DISABLE=true npm run build                →  0
bash scripts/test-backup-restore.sh             →  34 passed, 0 failed
bash scripts/test-update-flow.sh                →  24 passed, 0 failed
bash scripts/test-release-installer.sh          →  23 passed, 0 failed
bash scripts/test-service-contract.sh           →  26 passed, 0 failed
bash scripts/test-line-endings.sh               →  60 passed, 0 failed
```

No real secret appears in any fixture, log, or this file; the key material in
the test is a literal placeholder string.
