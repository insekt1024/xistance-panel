# Xistance Panel — Agent Guide

## What is this

Tunnel management panel (MTProto/FRP/GOST/SSH proxy orchestration) built with Next.js 16 App Router, Prisma, and a custom tunnel engine. Supports EN + Farsi (RTL).

## Quick commands

```bash
# Dev (must build packages first)
npm run dev

# Build (production)
npm run build

# Typecheck only
npm run typecheck

# Lint only
npm run lint

# Version management
npm run version:show
npm run version:bump -- patch

# Run optimization tests
TURBO_DISABLE=true npx tsx scripts/test-optimizations.ts
```

## Critical quirks

### Turbopack build error
`Invalid argument (os error 22)` when Turbopack encounters `tunnels/bin/gost`. Always:
```bash
TURBO_DISABLE=true npm run build
```

### Dev server
Requires `XT_FORCE_NODE=true` to run child processes (not systemd) in dev. Set in `apps/web/.env.local`.

### Build chain
Packages must build before app:
```bash
npm run build:packages  # types → tunnel-core → i18n → db
npm run build           # then app
```

### Prisma
- v6.19.3, SQLite dev DB at `$XT_DATA_DIR/xistance.db`
- Run `npm run build:packages` to generate Prisma client
- Production: absolute `DATABASE_URL` required

## Architecture

### Monorepo structure
- `apps/web/` — Next.js 16 App Router (standalone output)
- `packages/types/` — TypeScript types
- `packages/tunnel-core/` — Core tunnel engine (SSH, systemd/child processes)
- `packages/db/` — Prisma database
- `packages/i18n/` — Internationalization
- `packages/mocks/` — Mock data

### Route handler pattern
All API routes follow:
```typescript
import { z } from "zod";
import { requireSession, apiError, auditLog, parseBody } from "@/lib/api-helpers";

const Schema = z.object({ ... });

export async function POST(req: Request) {
  const session = await requireSession();
  const body = await parseBody(req, Schema);
  // ... business logic
  auditLog({ action: "SOMETHING", target: id });
  return Response.json({ ok: true });
}
```

### CSRF protection
Double-submit cookie: `xt_csrf` header must match cookie value. `parseBody()` handles this automatically.

### Database patterns
- Always use `select` to avoid fetching unnecessary fields
- `nodeToEndpoint()` requires: `id`, `host`, `sshUser`, `sshPort`, `authMethod`, `sshKeyEncrypted`, `sshPasswordEnc`
- Pagination: cursor-based with `hasNext`/`nextCursor`
- Parallel queries: `Promise.all([query1, query2])` for independent reads

### Engine
- Singleton via `getEngine()` in `apps/web/src/lib/engine.ts`
- `isRunning()` uses 3s TTL cache (`processRunningCache`)
- `flushStats()` writes debounced I/O stats to `engine-stats.json`
- `size()` returns count of active processes
- Lifecycle changes clear the running cache via `invalidateStatus()`

### Instrumentation
`apps/web/instrumentation.ts` runs on server start:
- Rehydrates running tunnels from DB (single `include` query)
- Reconciles port-forward rules
- Starts traffic sampler + maintenance (hourly audit/session pruning)
- Wires `flushStats()` to SIGTERM/SIGINT/beforeExit

### Rate limiting
In-memory fixed-window limiter in `apps/web/src/lib/rate-limit.ts`. Applied to:
- `tools` (20/min)
- `nodes/[id]/test` (10/min)
- `settings/password` (5/min)
- `tunnels/[id]/actions` (30/min)
- `tunnels/batch` (10/min)

### Query cache
`apps/web/src/lib/query-cache.ts`: TTL + single-flight. Use for expensive dashboard aggregates. Call `invalidateCache(prefix?)` after writes.

### API endpoints
- `GET /api/health` — unauthenticated, checks DB + engine size + version
- `GET /api/docs` — unauthenticated, API documentation
- `GET /api/metrics` — admin only, system metrics (tunnels, nodes, traffic, memory)

## UI conventions

### Motion system
Defined in `apps/web/app/globals.css`:
- `animate-fade-in-up` — staggered entrance (use `style={{ '--stagger': i }`)
- `animate-fade-in` — simple fade
- `animate-scale-in` — scale up
- `skeleton-shimmer` — loading skeleton
- `card-interactive` — hover lift + shadow
- All respect `prefers-reduced-motion`

### Components
- Shadcn UI (`components/ui/`)
- `lucide-react` for icons
- `recharts` for charts
- `sonner` for toasts
- `next-themes` for dark mode
- `class-variance-authority` + `tailwind-merge` for variants

### Styling
- Tailwind CSS v4: no `tailwind.config.js` — theme in `globals.css` via `@theme inline`
- Path alias: `@/*` → `./src/*`
- Fonts: `next/font/google` (Geist, Geist_Mono) as CSS vars
- RTL: `[lang="fa"]` uses Vazirmatn font

### Keyboard shortcuts
- `Ctrl+K` / `Cmd+K`: Open search
- `Ctrl+N` / `Cmd+N`: New tunnel
- `?`: Show shortcuts help
- `Escape`: Close dialogs

### Responsive design
- Desktop (>=768px): Standard table layout
- Mobile (<768px): Card-based layout for tables

## Testing

No test framework installed. Verification approach:
1. `npm run typecheck` — all packages + app
2. `npm run lint` — ESLint
3. `TURBO_DISABLE=true npx next build` — production build
4. `TURBO_DISABLE=true npx tsx scripts/test-optimizations.ts` — 31 dynamic DB tests

Test script creates temporary SQLite DB, pushes schema, runs tests, then cleans up.

## Environment

Copy `apps/web/.env.local.example` to `apps/web/.env.local`. Key vars:
- `XT_DATA_DIR` — data directory (defaults to `.data/`)
- `XT_FORCE_NODE` — run child processes instead of systemd
- `XTENC_KEY` — AES-256-GCM master key for encrypting secrets
- `JWT_SECRET` — session signing key
- `DATABASE_URL` — SQLite file path or PostgreSQL connection string

## CI/CD

- **CI** (`ci.yml`, `TURBO_DISABLE=true`): verify job (version:check → lint → typecheck → test-optimizations → non-blocking audit) then build job (next build + `docker build` validation). Standalone artifact uploaded on push.
- **Release** (`release.yml`, workflow_dispatch `patch|minor|major` + `dry-run`): bumps version (commit+tag stay local) → full verify + build → push commit+tag only if green → GitHub Release with tarballs → Docker image to GHCR (`:vX.Y.Z` + `:latest`).
- **Version**: `scripts/version.mjs` syncs root + 5 workspace manifests + `version.ts`. `npm run version:check` fails on drift. Never edit `version.ts` by hand.
- **Publishing**: `origin` → `https://github.com/insekt1024/xistance-panel` (branch `master`). Push, then use `release.yml` workflow_dispatch for releases.

## Skills installed

- `nextjs-performance` — React/Next.js optimization guidelines
