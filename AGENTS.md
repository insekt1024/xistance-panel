# AGENTS.md — Xistance Panel

<!-- init-deep root guide. Repo: xistance-panel, branch master, commit 8e366d8, generated 2026-09-24. -->
<!-- Tooling note: codegraph is unavailable and TypeScript LSP is not installed, so the CODE MAP below is static; reference counts are unmeasured. -->

Monorepo (npm workspaces `apps/*`, `packages/*`), Node >=20.9 (CI/Docker use Node 22).

## OVERVIEW

Next.js 16 App Router panel + API routes in `apps/web`, with shared
workspace packages for types, tunnel engine, i18n, and Prisma DB.
Default DB is SQLite; tunnel configs generate backhaul/frp/gost/ssh
samples under `tunnels/examples/`. Prod deploys via `scripts/` shell
scripts and a standalone Next output.

## STRUCTURE

- `apps/web/` — UI + `/api/*` routes. App dir is `apps/web/app/` (`[locale]/` + `api/`), not `src/app/`.
- `packages/types/` — shared TS types + zod schemas (e.g. `SshConfigSchema`).
- `packages/tunnel-core/` — engine, TOML/cmd builders, systemd/child-process runners, `security.ts`.
- `packages/db/` — Prisma SQLite-by-default schema + seed; client generated to `packages/db/generated/client` (gitignored).
- `packages/i18n/messages/en|fa.json` — message catalogs; update both locales together.
- `tunnels/examples/` — canonical generated configs. Rest of `tunnels/` is gitignored runtime data (binaries, logs, keys).
- `scripts/` — `install.sh`/`update.sh`/`backup.sh`/`uninstall.sh` (prod deploy), `version.mjs`, `test-optimizations.ts`.

## WHERE TO LOOK

- Web UI + API routes: `apps/web/app/[locale]/`, `apps/web/app/api/`, `apps/web/src/lib/`.
- Shared packages: `packages/types/`, `packages/tunnel-core/src/`, `packages/i18n/`, `packages/db/prisma/`.
- Canonical tunnel samples: `tunnels/examples/`.
- Prod scripts: `scripts/`.
- Seed admin + env template: `packages/db/prisma/seed.ts`, `apps/web/.env.local.example`.

## CODE MAP

Static map (no codegraph/LSP data; paths verified on disk):

- `apps/web/app/[locale]/` — localized pages (`next-intl`, RTL `en`/`fa`).
- `apps/web/app/api/` — route handlers; SSRF guard in `apps/web/src/lib/ssrf.ts` (`isBlockedTarget`/`isPrivateIp`).
- `apps/web/instrumentation.ts` — Node startup: rehydrate tunnels, reconcile forwards, start background jobs, flush stats.
- `apps/web/proxy.ts` — locale middleware; `next.config.ts` — standalone output and security headers.
- `apps/web/src/lib/` — `api.ts` (pulls `@xistance/db` singleton), `version.ts` (generated, do not hand-edit), rate-limit + query-cache.
- `packages/tunnel-core/src/engine.ts` — `processSpec`, systemd units (`xt-<id>-<role>.service`) vs plain child processes.
- `packages/tunnel-core/src/config/ssh.ts` — `filterExtraArgs`, `buildSshCommand`/`buildAutosshCommand`.
- `packages/tunnel-core/src/process.ts` — `sanitizeUnitText`/`buildUnit`.
- `packages/tunnel-core/src/` — also `binary.ts`, `runner.ts`, `forwarder.ts`, `forwarder-runner.ts`, `eventbus.ts`, `security.ts`.
- `packages/db/prisma/schema.prisma` — SQLite default; Postgres requires a separately maintained `schema.postgres.prisma` (not checked in).
- `packages/i18n/messages/en|fa.json` — keep `en` and `fa` in sync.

## CONVENTIONS

- Build order: `types` → `tunnel-core` → `i18n` → `prisma generate` → `web` (root `build:packages` first).
- Web `predev`/`prebuild` recompile package `dist/` via `tsconfig.build.json`; rerun `npm run build:packages` when cross-package types look stale.
- Bump versions only via `node scripts/version.mjs patch|minor|major|set X.Y.Z [--commit]`; syncs root + 5 workspace `package.json` files + `version.ts`.
- Update `en` and `fa` catalogs together.
- New tunnel/tool inputs must go through the security funnels (`filterExtraArgs`, `buildSshCommand`, `sanitizeUnitText`, `isBlockedTarget`, rate-limit, query-cache); never bypass.
- Never commit `tunnels/` runtime data (binaries, logs, keys, `.data/`, generated Prisma client).

## ANTI-PATTERNS

- Do not build/turbo-pack without `TURBO_DISABLE=true`; Turbopack chokes on `tunnels/bin/gost` (`os error 22`).
- Do not re-add `experimental.optimizePackageImports`; it panics Turbopack on Next 16.3.0 (see `next.config.ts`).
- Do not run `next start`; `output: "standalone"` makes it invalid. Run the standalone server file with env passed explicitly.
- Do not statically import `lib/api.ts` inside tests; Prisma resolves `DATABASE_URL` at import time and it points at the dev DB.
- Do not hand-edit `apps/web/src/lib/version.ts`.
- Do not set `XT_TRUST_PROXY=true` unless behind a sanitizing reverse proxy.

## COMMANDS

Run from repo root (`xistance-panel/`), never from the wrapper root:

```bash
npm install
npm run dev      # builds packages first, then next dev (needs apps/web/.env.local)
npm run lint     # eslint .
npm run typecheck
TURBO_DISABLE=true npx tsx scripts/test-optimizations.ts  # 49 tests, temp DB at .data/test.db
npm run version:check   # CI fails on version drift
TURBO_DISABLE=true npm run build
```

Verify order (mirrors CI `verify` job): `version:check` → `lint` → `typecheck` → tests → `build`.

## NOTES

- Standalone server: `node apps/web/.next/standalone/apps/web/server.js` with env passed explicitly (standalone does not load `.env.local`).
- Prisma import-time behavior: `test-optimizations.ts` sets its own env + temp DB; import `lib/api.ts` dynamically inside tests only (see comment at top of the test script).
- Default DB is SQLite (`$XT_DATA_DIR/xistance.db`, else `.data/`). Postgres needs `schema.postgres.prisma` + `prisma migrate deploy` (see header of `schema.prisma`).
- Engine mode: systemd units on Linux VPS, plain child processes without systemd (WSL). Set `XT_FORCE_NODE=true` in dev to force child processes.
- Default seed admin `admin@xistance.local` / `xistance-admin` (override `XT_ADMIN_EMAIL`/`XT_ADMIN_PASSWORD`).
- Leave unrelated dirty user edits in web auth/layout files untouched unless the task owns them.

## CHILD GUIDANCE

Max-depth-3 children for this pass; do not duplicate their domain details here:

- `apps/web/AGENTS.md` — web UI, routes, lib details.
- `packages/tunnel-core/AGENTS.md` — engine, builders, runners, security funnels.
- `packages/db/AGENTS.md` — Prisma schema, seeds, SQLite/Postgres handling.
