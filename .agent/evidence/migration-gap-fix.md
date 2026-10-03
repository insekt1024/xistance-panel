# Migration gap fix — a first install could not reach its database

**Status:** fixed and verified locally
**Origin:** recorded as a TASK-13 gap: on the VPS the health check reported
`database: unreachable` because `app.db` was 0 bytes and the app failed with
Prisma `P2021: table main.Tunnel does not exist`.

## Root cause

The release artifact ships the Prisma **client** but deliberately not the Prisma
**CLI**, the migration engine binaries, or ts-node. So a zero-build install
cannot run `prisma db push` or `prisma migrate deploy`. The previous
`install.sh` seeded the database via `npx prisma`, which requires a source
checkout and an install — precisely what the zero-build path avoids. The
release installer therefore deployed a release whose schema was never created.

## Fix

`scripts/apply-migrations.mjs` — applies pending migrations using only
`node:sqlite` (available since Node 22, already a release requirement) and the
migration SQL already present in the artifact.

Safety properties, each tested:

| Property | Test |
| --- | --- |
| Creates every table, including `Tunnel` | table list + `SELECT count(*) FROM "Tunnel"` |
| Idempotent | second run reports `0 applied` |
| Refuses drift | altered migration SQL → exit 1, "different checksum", nothing applied |
| Transactional | failing statement → exit 1, "rolled back", no partial table |
| Creates a missing parent directory | nested path that did not exist |
| Reports, never hides, an absent migrations dir | `no migrations found` |
| Invokes no build chain | source scan rejects `prisma db push` / `prisma migrate` / `npx ` / `next build` |

It writes to the same `_prisma_migrations` table the Prisma CLI uses, so a
later `prisma` invocation agrees about what has been applied. An existing
database is migrated in place and never dropped.

## Integration

- `stage-release-artifact.ts` stages the applier to the artifact root.
- `inspect-release-artifact.ts` requires it, so an artifact that cannot migrate
  fails inspection rather than failing at install time.
- `release-install.sh` runs it after extraction and **before** activation; a
  migration failure aborts with the release not activated.

## Verified against the staged artifact

Not just the script in the repo — the applier was run from the staged artifact
tree, exactly as the installer invokes it:

```
node dist/artifact/apply-migrations.mjs --database file:…/.agent/tmp-install/app.db \
     --migrations …/dist/artifact/packages/db/prisma/migrations
applied 20260823214332_init
EXIT=0
tables: 11
Tunnel queryable: YES
```

## Bugs found and fixed while building this

1. **Missing parent directory** — SQLite refused to create the file. A first
   install has no data dir yet, so `mkdirSync(dirname, {recursive:true})` was
   added. This alone would have broken every first install.
2. **`db.exec` cannot bind parameters** — the bookkeeping `INSERT` passed
   placeholders that never received values, producing
   `NOT NULL constraint failed: _prisma_migrations.id`. Replaced with
   `db.prepare(...).run(id, checksum, name)`. The transaction correctly rolled
   back, so no half-applied schema was left.
3. **`require` in an ESM test file** — the same mistake made in TASK-7, caught
   before running.
4. **Block-comment prose read as an invocation** — the test rejected
   `prisma db push` because the applier's own `/** */` header documents that it
   avoids that command. Comments are now stripped before scanning.

## Recorded gaps

1. **The applier is not yet proven on Linux/`node:sqlite` in production.** It
   runs correctly on this Windows host with Node 26. Ubuntu 24.04 ships
   Node 22.x, where `node:sqlite` exists but is still flagged experimental and
   may emit a warning. This must be confirmed on the VPS.
2. **Statement splitting is conservative.** It splits on a semicolon at the end
   of a line, which is how Prisma emits migrations. A semicolon inside a string
   literal would need a real SQL parser; the shipped migrations contain none
   (verified by grep), but a future migration could break this.
3. **No admin user is seeded.** The applier creates the schema only. Creating
   the initial super-admin needs `seed.ts`, which is TypeScript and therefore
   not in the zero-build artifact. A first install currently has no way to log
   in.
4. **PostgreSQL is not covered.** This applier is SQLite-only, which matches the
   documented default. A `postgres://` `DATABASE_URL` is not handled.

Gates: `test-apply-migrations` green; 7 TS release suites and 3 shell suites
green; `bash -n` on all shell scripts; version:check, lint, typecheck, release
`tsc` all exit 0; harness 77/77.
