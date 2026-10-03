# Local baseline evidence — TASK-2

Date: 2026-09-24
Repository: `xistance-panel`
Branch: `master`
Worktree: existing uncommitted user changes preserved; no reset/clean/commit was run.

## Toolchain

- Node.js: `v22.23.2`
- npm: `10.9.8`
- Git: `2.52.0.windows.1`
- `node_modules/`: present
- Docker CLI: present; Docker daemon: unavailable
- GitHub CLI: authenticated; credential values were not read or recorded

## Commands and results

All commands were run from `E:/codes/Projects/Xistance-Tunnel/xistance-panel`.

| Command | Exit | Result |
|---|---:|---|
| `npm run version:check` | 0 | All 7 version files match `1.1.2` |
| `npm run lint` | 0 | Passed; existing pages-directory advisory printed |
| `npm run typecheck` | 0 | Passed for web, types, tunnel-core, and db projects |
| `TURBO_DISABLE=true npx tsx scripts/test-optimizations.ts` | 0 | `77 passed, 0 failed of 77` |
| `TURBO_DISABLE=true npm run build` | 0 | Standalone build completed; warnings recorded below |

## Build diagnostics

The first build attempt failed in `prisma generate` with Windows `EPERM` while renaming `query_engine-windows.dll.node`. Process inspection found an active `next dev` process tree holding the generated Prisma DLL. The stale project dev process tree was stopped, `prisma generate` was rerun successfully, and the complete build then exited 0.

The successful build reported:

- Prisma `package.json#prisma` deprecation warning (Prisma 7 migration notice).
- Turbopack dynamic-filesystem tracing warnings from generated Prisma code, including a warning that the whole project may be traced.
- A CommonJS `export *` warning from the generated Prisma client.
- Standalone server present at `apps/web/.next/standalone/apps/web/server.js`.
- Raw standalone output did not contain `apps/web/.next/standalone/apps/web/.next/static` immediately after the build; release staging must explicitly copy both `apps/web/.next/static` and `apps/web/public` into the standalone tree. This is tracked by TASK-6 and is not treated as a passing release artifact until its focused smoke/inspection test passes.

## Security/privacy

No real secret values, env-file values, database contents, cookies, tokens, or private keys were copied into this evidence file.
