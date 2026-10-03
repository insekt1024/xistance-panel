# AGENTS.md — apps/web

Inherits `xistance-panel/AGENTS.md` for monorepo commands, build order, DB/engine, and versioning. This file covers web-only layout and boundaries.

Next.js 16.3.0 App Router + React 19, next-intl, Tailwind 4, Radix shims, `@xistance/*` workspace packages.

## Layout (non-obvious split)

- Routes live in `app/`, not `src/app/`: UI under `app/[locale]/` (`(app)/` group + `login/`), APIs under `app/api/`.
- `src/lib/` holds server/shared helpers (auth, api, ssrf, rate-limit, query-cache, engine, sampler, maintenance, tunnels).
- UI lives in `src/components/` plus `src/components/ui/` shims; i18n request/routing under `src/i18n/`.
- `proxy.ts` is the next-intl middleware (locale negotiation; skips `api/`, `_next`, static files).
- `instrumentation.ts` runs once on the Node runtime only: rehydrates running tunnels via `buildDeploySpec` + `getEngine().deploy()`, reconciles port-forwards, starts traffic sampler + maintenance, flushes engine stats on SIGTERM/SIGINT.

## WHERE TO LOOK

- UI routes: `app/[locale]/(app)/*/page.tsx` + colocated `*-view.tsx` (dashboard, tunnels, nodes, users, audit, webhooks, tools, settings, port-forward).
- API routes: `app/api/*/route.ts` (auth, tunnels, nodes, port-forwards, tools, xui, metrics, traffic, settings, webhooks, users, audit, health).
- Auth/session/CSRF/rate-limit/query-cache: `src/lib/auth.ts`, `src/lib/api.ts` (`requireSession`, `csrfGuard`, `getClientIp`), `src/lib/rate-limit.ts`, `src/lib/query-cache.ts`, `src/lib/jwt.ts`.
- SSRF + HTTP/tool probes: `src/lib/ssrf.ts` (`isBlockedTarget`/`isPrivateIp`) and `app/api/tools/route.ts`; SSH node connectivity: `app/api/nodes/[id]/test/route.ts`.
- Background jobs: `src/lib/sampler.ts`, `src/lib/maintenance.ts`, `src/lib/forward-supervisor.ts`, `src/lib/traffic.ts`, wired in `instrumentation.ts`.
- App config: `next.config.ts` (standalone, CSP/security headers), `proxy.ts`, `src/i18n/routing.ts` + `src/i18n/request.ts`, `tsconfig.json`.

## Invariants

- Route files: UI is `page.tsx` (+ `layout.tsx`/`loading.tsx`/`error.tsx` where present); APIs are `route.ts` exporting named HTTP-method handlers.
- Imports use the `@/*` alias for `./src/*` (see `tsconfig.json`); prefer `@/lib/*` and `@xistance/*` over relative climbs.
- Locales: `en` + `fa` only; catalogs live in `packages/i18n/messages/en|fa.json`, update both together; the proxy matcher never rewrites `/api/*`.
- Standalone + Turbopack: `output: "standalone"`, never `next start`; build only with `TURBO_DISABLE=true`; never re-add `experimental.optimizePackageImports` (panics Next 16.3.0).

## Security boundaries (do not bypass)

- Protected mutating/sensitive API routes call `requireSession()` (which runs `csrfGuard()`) from `src/lib/api.ts` first; public health/login/refresh routes are exceptions.
- Forwarded headers (`X-Forwarded-For`, `X-Forwarded-Host`) are gated: trusted only when `XT_TRUST_PROXY=true` behind a sanitizing proxy. `X-Forwarded-Proto` determines the cookie scheme; it is not a client-IP trust gate.
- Tool HTTP/TCP/latency probes use `isBlockedTarget()` and `fetch(..., { redirect: "manual" })`; URL credentials are rejected. SSH node tests use their own rate limit and SSH credential flow, not the HTTP SSRF gate.
- Exception: `app/api/xui/test/route.ts` intentionally skips the private-IP SSRF block because 3X-UI panels usually live on private nets; credentials still go in fields, never in the URL.

## Commands (run from `xistance-panel/`)

```bash
npm run dev
npm run lint
npm run typecheck
TURBO_DISABLE=true npm run build
```

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
