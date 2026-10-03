# Environment variable inventory — TASK-4

Date: 2026-09-24
Repository: `xistance-panel`

This inventory records variable names and purposes only. It does not contain values from `apps/web/.env.local`, production hosts, credentials, cookies, tokens, or database contents.

## Application and package runtime

| Name | Source / purpose | Sensitivity |
|---|---|---|
| `DATABASE_URL` | Prisma database connection; explicit URL wins, otherwise SQLite under `XT_DATA_DIR`/`.data` | sensitive connection data |
| `JWT_SECRET` | Signs/verifies access JWTs; required in production | secret |
| `NODE_ENV` | Runtime/build mode; production changes cookie/security behavior | configuration |
| `NEXT_RUNTIME` | Instrumentation runtime guard; web server uses `nodejs` | configuration |
| `XTENC_KEY` | Master key for AES-256-GCM secret storage and scrypt fallback | secret |
| `XT_DATA_DIR` | Tunnel runtime/config/log/key data directory | sensitive path |
| `XT_KEY_DIR` | Directory for materialized SSH key files | sensitive path |
| `XT_ENV_FILE` | Optional engine environment file path | sensitive path |
| `XT_FORWARDER_SCRIPT` | Port-forward worker script path | configuration |
| `XT_FORCE_NODE` | Forces child-process mode in development/WSL | configuration |
| `XT_PANEL_HOST` | Optional panel host used to identify local-node endpoints | configuration |
| `XT_TRUST_PROXY` | Opt-in trust for sanitized proxy headers and client IP | security-sensitive |
| `XT_ALLOWED_ORIGINS` | Additional browser origins for origin/CSRF checks | security-sensitive |
| `XT_ADMIN_EMAIL` | Seeded initial admin email | sensitive |
| `XT_ADMIN_PASSWORD` | Seeded initial admin password | secret |
| `XT_DEMO` | Enables demo seed data only when exactly `true` | configuration |

Source scan locations included `apps/web/src/lib/auth.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/engine.ts`, `apps/web/src/lib/tunnels.ts`, `apps/web/instrumentation.ts`, `apps/web/next.config.ts`, `packages/db/src/index.ts`, `packages/db/prisma/seed.ts`, and `packages/tunnel-core/src/security.ts`.

## Installer, bootstrap, and service inputs

| Name | Source / purpose | Sensitivity |
|---|---|---|
| `XT_INSTALL_DIR` | Override installer application directory | path |
| `XT_DATA_DIR` | Override mutable data directory | sensitive path |
| `XT_BIN_DIR` | Override tunnel binary directory | sensitive path |
| `XT_PORT` | Default panel HTTP port | configuration |
| `XT_ADMIN_EMAIL` | Installer seed admin email | sensitive |
| `XT_ADMIN_PASSWORD` | Installer seed admin password | secret |
| `XT_LANG` | Installer message language (`en`/`fa`) | configuration |
| `XT_MIRROR` | GitHub/mirror base for checkout and binary downloads | security-sensitive |
| `BACKHAUL_VERSION` | Backhaul binary release tag | supply-chain input |
| `FRP_VERSION` | FRP binary release tag | supply-chain input |
| `GOST_VERSION` | GOST binary release tag | supply-chain input |
| `XRAY_VERSION` | Xray binary release tag | supply-chain input |
| `TURBO_DISABLE` | Forces the documented non-Turbopack build path | build configuration |
| `NEXT_TELEMETRY_DISABLED` | Disables Next telemetry during installer/update builds | build configuration |
| `NODE_OPTIONS` | Optional low-memory heap cap selected by installer | build configuration |

Internal shell variables (for example `INSTALL_DIR`, `DATA_DIR`, `REPO_ROOT`, `BRANCH`, and `SUDO_ARGS`) are implementation locals and are not user-facing environment inputs.

## Template verification

`apps/web/.env.local.example` now lists the observed application/runtime names with non-secret paths, `TODO_FILL_MANUALLY` markers for secrets, and safe example origins/hosts. It contains no real values copied from a local environment file.

Real values must be entered manually on the local development machine or VPS. `XT_TRUST_PROXY=true` is safe only behind a sanitizing reverse proxy; `XTENC_KEY`, `JWT_SECRET`, admin credentials, database URLs, and key material must never be written to task specs, evidence, logs, or chat.
