# AGENTS.md — Xistance Panel

Monorepo (npm workspaces `apps/*`, `packages/*`), Node >=20.9 (CI/Docker use Node 22).

## Layout

- `apps/web` — Next.js 16 App Router UI + `/api/*` routes. App dir is `apps/web/app/` (`[locale]/` + `api/`), not `src/app/`. `next-intl` with RTL `en`/`fa`.
- `packages/types` — shared TS types + zod schemas (e.g. `SshConfigSchema`).
- `packages/tunnel-core` — engine, TOML/cmd builders, systemd/child-process runners, `security.ts` (SSRF, argv/unit sanitizing).
- `packages/db` — Prisma SQLite-by-default schema + seed; client generated to `packages/db/generated/client` (gitignored).
- `packages/i18n/messages/en|fa.json` — message catalogs; update both locales together.
- `tunnels/examples/` — canonical generated backhaul/frp/gost/ssh configs. Rest of `tunnels/` is gitignored runtime data (binaries, logs, keys) — never commit there.
- `scripts/` — `install.sh`/`update.sh`/`backup.sh`/`uninstall.sh` (prod deploy), `version.mjs`, `test-optimizations.ts`.

## Commands

```bash
npm install
npm run dev      # builds packages first, then next dev (needs apps/web/.env.local)
npm run lint     # eslint .
npm run typecheck
TURBO_DISABLE=true npx tsx scripts/test-optimizations.ts  # 49 tests, temp DB at .data/test.db
npm run version:check   # CI fails on version drift
```

Verify order (mirrors CI `verify` job): `version:check` → `lint` → `typecheck` → tests → `build`.

## Gotchas

- **Always build with `TURBO_DISABLE=true`** (`TURBO_DISABLE=true npm run build`). Turbopack chokes on `tunnels/bin/gost` (`os error 22`). Do not re-add `experimental.optimizePackageImports` — it panics Turbopack on Next 16.3.0 (see `next.config.ts`).
- **Build order matters:** root `build`/`dev` run `build:packages` first (`types` → `tunnel-core` → `i18n` → `prisma generate`). Web `predev`/`prebuild` recompile package `dist/` via `tsconfig.build.json`. If cross-package types look stale, rerun `npm run build:packages`.
- **`output: "standalone"` — `next start` is invalid.** Run `node apps/web/.next/standalone/apps/web/server.js` with env passed explicitly (standalone does not load `.env.local`).
- **Prisma client resolves `DATABASE_URL` at import time.** `test-optimizations.ts` sets its own env + temp DB; import `lib/api.ts` dynamically inside tests only (it pulls the `@xistance/db` singleton). Static import points at the dev DB — see comment at top of the test script.
- **Never edit `apps/web/src/lib/version.ts` by hand.** Bump via `node scripts/version.mjs patch|minor|major|set X.Y.Z [--commit]`; it syncs root + 5 workspace `package.json` files + `version.ts`.
- **Default DB is SQLite** (`$XT_DATA_DIR/xistance.db`, else `.data/`). Postgres needs a separate `schema.postgres.prisma` + `prisma migrate deploy` (see header of `schema.prisma`).
- **Engine mode:** systemd units (`xt-<id>-<role>.service`, see `processSpec` in `packages/tunnel-core/src/engine.ts`) on Linux VPS, plain child processes without systemd (WSL). Set `XT_FORCE_NODE=true` in dev to force child processes.
- **`XT_TRUST_PROXY=true` only behind a sanitizing reverse proxy** (it trusts `X-Forwarded-For` for rate limits). Default seed admin `admin@xistance.local` / `xistance-admin` (override `XT_ADMIN_EMAIL`/`XT_ADMIN_PASSWORD`); see `packages/db/prisma/seed.ts` and `apps/web/.env.local.example`.
- **Security-sensitive code:** `filterExtraArgs` / `buildSshCommand`/`buildAutosshCommand` (`tunnel-core/src/config/ssh.ts`), `sanitizeUnitText`/`buildUnit` (`tunnel-core/src/process.ts`), `isBlockedTarget`/`isPrivateIp` (`apps/web/src/lib/ssrf.ts`), rate-limit, query-cache. Don't bypass; new tunnel/tool inputs must go through them.
