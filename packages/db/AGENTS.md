# AGENTS.md — packages/db

Prisma SQLite-by-default package. Single source of truth plus a thin singleton boundary.

## Ownership

- `prisma/schema.prisma` is the source of truth. Edit models here, nowhere else.
- `prisma/migrations/` is the SQLite migration history (one `*_init` migration). Never hand-edit applied migrations.
- `migration_lock.toml` pins `provider = "sqlite"`. Do not edit it.
- `prisma/seed.ts` is the seed entry (`prisma.seed` in `package.json`). Creates the super admin, plus demo nodes/tunnel/rule only when `XT_DEMO=true`.
- `src/index.ts` is the export boundary. App code imports `{ prisma }` from `@xistance/db` (re-exported generated types included). Nothing else.

## Generated boundary

- `generated/client/` is regenerated output (`output = "../generated/client"` in the schema). Never edit it, never commit it, never deep-import it from app code.
- One intentional exception: `scripts/test-optimizations.ts` imports `PrismaClient` directly from `packages/db/generated/client/index.js` to build an isolated client against a temp DB. Do not copy that pattern into app routes.

## URL resolution

`src/index.ts` resolves the URL at import time, in this order:

1. Explicit `DATABASE_URL` (prod `install.sh` exports an absolute path).
2. `$XT_DATA_DIR/xistance.db`.
3. `<cwd>/.data/xistance.db`.

Because resolution happens at import time, tests must set env vars before importing the singleton (see the note at the top of `test-optimizations.ts`: it sets `DATABASE_URL` first and imports `lib/api.ts` dynamically inside tests).

## SQLite vs Postgres

- Default is SQLite, zero-config single file.
- Postgres requires a separately maintained `schema.postgres.prisma` with the same models and `provider = "postgresql"`, deployed via `prisma migrate deploy`. No Postgres schema or migration history is checked in; do not reuse the SQLite lock/history blindly.

## Commands (run from `xistance-panel/`)

```bash
npm run --workspace @xistance/db generate   # prisma generate, runs last in root build
npm run --workspace @xistance/db db:push    # quick local schema sync, no migration file
npm run --workspace @xistance/db migrate    # prisma migrate dev (SQLite history)
npm run --workspace @xistance/db deploy     # prisma migrate deploy (prod/Postgres)
npm run --workspace @xistance/db seed       # tsx prisma/seed.ts
npm run --workspace @xistance/db seed -- --reset  # wipe tables, recreate admin
npm run --workspace @xistance/db typecheck  # tsc --noEmit
```

## Rules

- Persisted schema change means: edit `schema.prisma`, create a migration, run `generate`, rerun `typecheck`. Use `db:push` only for throwaway/local test databases.
- Seed stays idempotent: `findUnique`/`upsert` before create, `--reset` only wipes when passed explicitly.
- Credential defaults belong in `seed.ts`; do not hardcode or duplicate them in app code.
