<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/xistance-logo.png" />
    <img src="docs/xistance-logo-light.png" alt="Xistance Panel logo" width="128" />
  </picture>
</p>

<h1 align="center">Xistance Panel</h1>

<p align="center">
  Self-hosted control panel for managing cross-border tunnel servers —
  <strong>Backhaul</strong>, <strong>FRP</strong>, <strong>GOST</strong>, and
  <strong>SSH</strong> port forwards — with a bilingual (English / فارسی) web UI.
</p>

<p align="center">
  <a href="https://github.com/insekt1024/xistance-panel/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/insekt1024/xistance-panel/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/insekt1024/xistance-panel/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/insekt1024/xistance-panel" /></a>
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-black" />
  <img alt="Prisma" src="https://img.shields.io/badge/Prisma-6-2D3748" />
</p>

<p align="center">
  پنل مدیریت سرویس‌های تانل (بک‌هال، FRP، GOST و SSH) با رابط کاربری دوزبانه
  (فارسی / انگلیسی) و پشتیبانی از کنترل کامل نودهای ایران و خارج.
</p>

## Contents

- [Features](#features)
- [Architecture](#architecture)
- [Quick start (development)](#quick-start-development)
- [Install on a server](#install-on-a-server-ubuntu-2204--2404)
- [Running the production build manually](#running-the-production-build-manually)
- [Example configs](#example-configs)
- [Commands](#commands)
- [Versioning](#versioning)
- [CI/CD](#cicd)

## Features

- **Dashboard** — tunnel/node status at a glance, traffic chart with range
  selector (1h–7d), live health + connection indicators.
- **Tunnels** — Backhaul, FRP, GOST and SSH relays; TCP & UDP; per-node roles
  (Iran / Foreign); live logs with search/filter, batch start/stop/restart,
  JSON import/export.
- **Resilient SSH** — SSH tunnels run under `autossh` by default, so the client
  is respawned the moment a link drops instead of waiting for the process to
  exit. Toggle it per tunnel in the wizard; nodes without `autossh` installed
  fall back to plain `ssh` automatically.
- **Nodes** — register Iran/Foreign servers, test SSH connectivity, track
  status/traffic; one-liner prep script for remote VPS bootstrapping.
- **Port forwarding** — quick relay rules (local forwarder, node-based).
- **Test tools** — TCP / latency / DNS / censorship probes with rate limiting.
- **Audit log + user activity** — every mutating action is logged with actor,
  target and IP; browsable per-user activity page.
- **Users & roles** — `SUPER_ADMIN` / `ADMIN` / `USER`, per-user tunnel quotas,
  session management with password-change revocation.
- **Webhooks** — Telegram/Discord notifications for tunnel and node events.
- **Settings** — encrypted backup/restore, password change, theme, API docs
  (`/api/docs`) and Prometheus-friendly metrics (`/api/metrics`).
- **Bilingual UI** — `en` and `fa` locales with RTL layout.
- **Power-user UX** — global search (`Ctrl+K`), keyboard shortcuts (`?` for
  help), dark mode, mobile card layouts, staggered motion (reduced-motion
  aware).

## Architecture

```
apps/web              Next.js App Router UI + API routes (/api/*)
packages/i18n         en / fa message catalogs
packages/tunnel-core  engine + config builders (TOML / command lines) + process management
packages/db           Prisma schema, seed (admin user), SQLite by default / Postgres optional
packages/types        shared TypeScript types
scripts/              bootstrap.sh, install.sh, update.sh, backup.sh, uninstall.sh
docs/                 project logo and docs
tunnels/              runtime data dir (binaries, configs, logs, dev.db)
Dockerfile            multi-stage build with /api/health healthcheck
```

`DATABASE_URL` defaults to a SQLite file at `$XT_DATA_DIR/xistance.db` (falls
back to `.data/` in the repo). To use Postgres instead, see
`docker/docker-compose.postgres.yml` and the note in
`packages/db/prisma/schema.prisma`.

Built with Next.js 16, React 19, and a shared TypeScript core that drives real
processes over systemd (or child processes in dev).

## Quick start (development)

```bash
npm install
cp apps/web/.env.local.example apps/web/.env.local   # or create your own
npm run dev
```

Dev server: `http://localhost:3000` (default admin `admin@xistance.local` /
`xistance-admin`, seeded via `packages/db/prisma/seed.ts`; override with
`XT_ADMIN_EMAIL` / `XT_ADMIN_PASSWORD`).

On a machine without systemd (e.g. WSL) the engine runs tunnel processes as
plain child processes; on a Linux VPS it manages systemd units
(`xt-tunnel-<id>.service`) automatically. Set `XT_FORCE_NODE=true` in dev to
force child processes.

> **Build quirk:** Turbopack chokes on the `tunnels/bin/gost` binary
> (`Invalid argument (os error 22)`), so always build with
> `TURBO_DISABLE=true npm run build`.

## Install on a server (Ubuntu 22.04 / 24.04)

One-liner (downloads the installer, then runs it — flags, prompts and
`--menu` all work because the script is saved to a file first, not piped):

```bash
curl -fsSL https://raw.githubusercontent.com/insekt1024/xistance-panel/master/scripts/bootstrap.sh \
  -o /tmp/xp-install.sh && sudo bash /tmp/xp-install.sh \
  --port 8080 --admin-email you@example.com
```

With a custom admin password (omit it and one is generated + printed):

```bash
sudo bash /tmp/xp-install.sh --port 8080 \
  --admin-email you@example.com --admin-password 'S3cret!'
```

From a local checkout instead:

```bash
git clone https://github.com/insekt1024/xistance-panel.git && cd xistance-panel
sudo bash scripts/install.sh --port 8080 --admin-email you@example.com
sudo bash scripts/install.sh --menu        # process-control menu
sudo bash scripts/install.sh --node iran   # remote-node binaries only
```

What the installer does:

- Preflight checks (root, arch, Ubuntu/Debian version, disk/RAM, port free,
  systemd, connectivity), then installs OS deps (`curl unzip jq sqlite3
  openssh-client sshpass autossh tar gnupg systemd ufw openssl iproute2`),
  Node ≥ 22, and `backhaul` / `frp` / `gost` binaries into
  `/var/lib/xistance/bin`.
  Hosts with < 1.5G RAM automatically get a 2G `/swapfile` (skippable with
  `--no-swap`) so `npm ci` / the Next.js build don't OOM.
- Writes config to `/etc/xistance/xistance.env` (auto-generated `XTENC_KEY`
  and `JWT_SECRET`, mode 600; re-runs keep secrets and update the port).
- Builds the panel with `npm ci && npm run build` (`TURBO_DISABLE=true`) and
  deploys it to `/opt/xistance` (standalone output).
- Initializes the database and seeds the admin account.
- Installs the `xistance.service` systemd unit and starts it.
- Opens the panel port via `ufw` (skippable with `--skip-firewall`).
- Verifies `/api/health` at the end.

Resumable: every step is recorded in `/var/lib/xistance/.install-state`.
If a step fails you get retry / skip / abort, and re-running the same command
continues where it stopped (`--from <step>`, `--only <step>`, `--redo`,
`--no-resume`). Full log at `/var/log/xistance-install.log`.

Options:

| Flag | Meaning |
| --- | --- |
| `--port 8080` | Panel listen port (default 8080, or `$XT_PORT`) |
| `--admin-email`, `--admin-password` | Admin login (password generated + printed if omitted) |
| `--data-dir`, `--install-dir` | Data / install dirs (defaults `/var/lib/xistance`, `/opt/xistance`) |
| `--branch`, `--repo` | Checkout source (defaults `master`, this repo) |
| `--lang en\|fa` | Prompt language (default `en`) |
| `--node iran\|foreign` | Remote-node binaries only |
| `--menu` | Interactive process-control menu (install/update/status/logs/rollback/…) |
| `--status` | Show service + health status and exit |
| `--skip-firewall` | Don't touch ufw |
| `--no-swap` | Don't auto-provision a swapfile on low-RAM hosts |
| `--rollback` | Restore the previous version before this install (if a backup exists) |
| `--allow-os` | Allow untested OS versions |
| `--yes` | Non-interactive (no prompts) |

Env overrides: `XT_ADMIN_EMAIL`, `XT_ADMIN_PASSWORD`, `XT_PORT`, `XT_DATA_DIR`,
`XT_BIN_DIR`, `XT_INSTALL_DIR`, `XT_MIRROR`, `BACKHAUL_VERSION`, `FRP_VERSION`,
`GOST_VERSION`, `XT_LANG`.

Other scripts: `scripts/update.sh` (pull + rebuild + restart),
`scripts/backup.sh` (tar of data + config, kept under `/var/backups/xistance`),
`scripts/uninstall.sh [--purge]`.

## Running the production build manually

The app uses `output: "standalone"`, so `next start` is **not** valid. Run the
standalone server directly and pass env explicitly (standalone does not load
`.env.local`):

```bash
DATABASE_URL="file:./.data/xistance.db" \
XT_DATA_DIR="$PWD/.data" XT_FORCE_NODE=true \
XTENC_KEY=... JWT_SECRET=... PORT=3000 HOSTNAME=0.0.0.0 \
node apps/web/.next/standalone/apps/web/server.js
```

Or via Docker (healthcheck hits `/api/health`):

```bash
docker build -t xistance-panel .
docker run -p 3000:3000 --env-file /etc/xistance/xistance.env xistance-panel
```

## Example configs

Working TOML / command examples for each relay live in `tunnels/examples/`
(`backhaul-foreign.toml`, `backhaul-iran.toml`, `frp-frps.toml`, `frp-frpc.toml`,
`gost-relay.sh`, `ssh-tunnel.sh`). They mirror exactly what the panel generates.

## Commands

- `npm run dev` — dev server (builds packages first)
- `npm run build` — production build (set `TURBO_DISABLE=true`, see above)
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript across all packages + app
- `npm run version:show` / `version:check` / `version:bump -- patch` — version tools
- `TURBO_DISABLE=true npx tsx scripts/test-optimizations.ts` — 49 dynamic tests
  (DB selects/pagination, cache scoping, rate limits, SSRF, SSH argv, systemd units)

## Versioning

The panel version is shown in the footer (`Xistance Panel vX.Y.Z`, linking to the
GitHub repo) and is kept in sync across `package.json` files and
`apps/web/src/lib/version.ts` by `scripts/version.mjs` — never edit
`version.ts` by hand:

```bash
npm run version:show                 # print current version
npm run version:check                # fail if any version file drifted
npm run version:bump -- patch        # bump patch -> 1.0.1
npm run version:bump -- minor        # 1.1.0
npm run version:bump -- major        # 2.0.0
node scripts/version.mjs set 1.2.3   # exact version
node scripts/version.mjs patch --commit  # bump + git commit + tag vX.Y.Z
```

## CI/CD

- **CI** (`ci.yml`, `TURBO_DISABLE=true`): `verify` job (`version:check` →
  lint → typecheck → 49 optimization tests → non-blocking audit), then `build`
  job (`next build` + `docker build` validation). Standalone artifact uploaded
  on push.
- **Release** (`release.yml`, `workflow_dispatch` with `patch|minor|major` +
  `dry-run`): bumps the version (commit + tag stay local) → full verify +
  build → pushes commit + tag only if green → GitHub Release with tarballs
  and auto-generated notes → Docker image to GHCR (`:vX.Y.Z` + `:latest`).
- **Dependabot** watches npm, GitHub Actions and Docker weekly.

Clone from `https://github.com/insekt1024/xistance-panel` to activate the
workflows.
