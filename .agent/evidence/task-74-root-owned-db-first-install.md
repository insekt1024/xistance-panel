# TASK-74 — first install left the database root-owned: health 200, every write failed

Date: 2026-09-30
Status: defect found on Ubuntu 24.04.5, fixed, mutation-verified in-place and in-suite
Scope: `scripts/release-install.sh`, `scripts/test-release-installer.sh`

## Summary

On the Ubuntu 24.04.5 target the service reported **healthy** — `/api/health`
200, `/api/nodes` 401, unit active — while the service user could not write to
its own database. The journal carried 20 occurrences of:

```
[PrismaClientUnknownRequestError]: Invalid `prisma.session.deleteMany()` invocation:
Error occurred during query execution:
ConnectorError(ConnectorError { ... SqliteError { extended_code: 8,
  message: Some("attempt to write a readonly database") } })
```

`/var/lib/xistance/app.db` was `root:root 0644` while the unit ran as
`xistance`. This is the worst failure shape in this class: every observable
signal says the release works, and the panel silently fails to persist.

## Root cause: an ordering bug, not a missing chown

The installer chowned the data dir at line 441, while `$DATA_DIR` was still
**empty**, because the database is created later by the migration at the
`apply-migrations.mjs` invocation:

```
441  chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR"     # nothing to chown yet
...
480  "$NODE_BIN" "$CANDIDATE_DIR/apply-migrations.mjs" ...    # creates app.db AS ROOT
```

On a **first** install the `chown -R` has nothing to act on, so `app.db` is
created root-owned and never corrected. On a **re-install** the file already
exists and the early `chown -R` does cover it — which is why this survived
every earlier test: the local installer suite and all prior target evidence ran
against data dirs that already contained a database.

## Fix

`scripts/release-install.sh` — re-assert ownership of the data dir *after* the
migration has created the file:

```bash
"$NODE_BIN" "$CANDIDATE_DIR/apply-migrations.mjs" \
  --database "file:${MIGRATION_DB}" \
  --migrations "$CANDIDATE_DIR/packages/db/prisma/migrations" \
  || die "Database migration failed. The release was not activated." 7
if [[ "$(id -u)" -eq 0 ]] && id -u "$SERVICE_USER" >/dev/null 2>&1; then
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR" 2>/dev/null \
    || die "Could not give ${SERVICE_USER} ownership of ${DATA_DIR}." 9
fi
```

An earlier draft added a `touch` plus a file-level `chown` before the migration
as well. Mutation showed that half is **not** load-bearing (see below), so it
was removed rather than left in as untested code.

## Target proof (Ubuntu 24.04.5, systemd PID 1, amd64)

`su -s /bin/sh xistance -c "test -w /var/lib/xistance/app.db"`:

| case | script | `app.db` owner | writable by `xistance` |
|---|---|---|---|
| first install, pre-fix | post-migration chown removed | `root:root` | **NO — defect reproduced** |
| first install, pre-fix (full revert) | both halves removed | `root:root` | **NO — defect reproduced** |
| first install, post-migration chown only | early chown removed | `xistance:xistance` | YES |
| first install, full fix | — | `xistance:xistance` | YES |

Each case ran with a **fresh empty** data dir (`/var/lib/xd-probe`) and a
separate install dir, because with a pre-existing `app.db` the early `chown -R`
masks the bug entirely.

After the fix, on the real target install:

```
installer exit 0
✓ Checksum verified (sha256sum).
✓ Xistance Panel v1.2.0 is installed and healthy on port 8080.
app.db  xistance:xistance   writable by xistance: YES
/api/health -> 200
/api/nodes  -> 401
unit: active
readonly errors in last 2min: 0
```

## The mutation that "survived" was an invalid control

The first attempt to prove the fix load-bearing removed only the post-migration
chown and reinstalled into the **existing** data dir. Result: the mutant
"survived", `app.db` came out `xistance:xistance`, writable. That was not a weak
fix — it was a broken test. With `app.db` already present, the early
`chown -R` at line 441 owns it, so the removed block was never load-bearing in
that setup.

Redoing the mutation against an **empty** data dir showed the opposite: the
pre-fix installer leaves `root:root` and denies writes. The lesson generalises:
**a permissions/migration defect on a first-install path cannot be reproduced
by re-running an installer over an existing state** — the second run takes a
different branch.

## Regression test

`scripts/test-release-installer.sh` asserts the chown comes *after* the
migration, by comparing line numbers:

```bash
_mig_line=$(grep -nE '^\s*"\$NODE_BIN" "\$CANDIDATE_DIR/apply-migrations\.mjs"' ... | head -1 | cut -d: -f1)
_chown_line=$(grep -nE 'chown -R "\$SERVICE_USER":"\$SERVICE_USER" "\$DATA_DIR"' ... | tail -1 | cut -d: -f1)
[ "$_chown_line" -gt "$_mig_line" ]
```

Asserting that a chown *exists* cannot work here — the bug is its position, and
a chown placed before the migration reproduces the defect while satisfying any
presence check.

### Suite mutation results

| mutant | suite | result |
|---|---|---|
| post-migration chown removed (exact pre-fix) | `test-release-installer.sh` | **KILLED** (exit 1) |
| same chown, moved *before* the migration | `test-release-installer.sh` | **KILLED** (exit 1) |
| fixed installer (control) | `test-release-installer.sh` | PASS (exit 0) |

File restored byte-identical after the run (verified by byte comparison).

## Regression check

- `bash -n` clean on both edited scripts; 0 CR bytes in either (a CRLF shipped
  shell script is a total install outage on the target).
- `npx tsx scripts/run-all-tests.ts` — **51/51 suites passed**, PASS.
- `scripts/release-install.sh` — 723 lines, 0 CR bytes.
- `scripts/test-release-installer.sh` — 582 lines, 0 CR bytes.

## Two of my own probes were wrong before the right one

Recorded because each nearly produced a fabricated finding:

- The first health probe used port **3000** and returned `000`, which reads as
  "the service is down". The unit actually listens on **8080**. Verify the port
  from the unit, not from a habit.
- `--admin-email` / `--admin-password` are **not** installer flags; the real
  inputs are the `XT_ADMIN_EMAIL` / `XT_ADMIN_PASSWORD` environment variables.
  The rejected invocation exited before the install, and the target looked
  unchanged — which is exactly the "did nothing but looked fine" shape.

## What remains open

- Distinct-host REVERSE unproven; `GatewayPorts clientspecified` not applied
  (approval timed out, twice).
- Live post-fix password-reset run not executed (approval timed out). The
  doc-path defect itself is fixed and bound to a test.
- arm64: the release cell is now wired to a real arm64 runner and mutation-
  verified, but no arm64 archive has been built — that needs CI.
- Task JSON step flags remain 60/303 `pass: true`.
- No `v1.2.0` tag, commit, push, or public release exists.
