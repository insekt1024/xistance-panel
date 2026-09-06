# Xistance Panel

Self-hosted control panel for managing cross-border tunnel servers —
**Backhaul**, **FRP**, **GOST**, and **SSH** port forwards — with a bilingual
(English / فارسی) web UI. Built with Next.js 16, React 19, and a shared
TypeScript core that drives real processes over systemd (or child processes in
dev).

پنل مدیریت سرویس‌های تانل (بک‌هال، FRP، GOST و SSH) با رابط کاربری دوزبانه
(فارسی / انگلیسی) و پشتیبانی از کنترل کامل نودهای ایران و خارج.

## Features

- **Tunnels** — Backhaul, FRP, GOST and SSH port forwards; TCP & UDP; per-node roles (Iran / Foreign).
- **Nodes** — register Foreign nodes, run the bundled installer remotely, and track status/traffic.
- **Port forwarding** — quick relay rules (local forwarder, node-based).
- **Tools** — privacy helpers (backup/restore, secrets, network info) and the bundled xistence CLI bridge.
- **Bilingual UI** — `en` and `fa` locales with RTL layout.
- **Traffic & status** — live line logs, bytes read/written per process, systemd or child-process lifecycle.

## Architecture

```
apps/web              Next.js App Router UI + API routes (/api/*)
packages/i18n         en / fa message catalogs
packages/tunnel-core  engine + config builders (TOML / command lines) + process management
packages/db           Prisma schema, seed (admin user), SQLite by default / Postgres optional
packages/types        shared TypeScript types
scripts/              install.sh, update.sh, backup.sh, uninstall.sh
tunnels/              runtime data dir (binaries, configs, logs, dev.db)
```

`DATABASE_URL` defaults to a SQLite file at `$XT_DATA_DIR/xistance.db` (falls
back to `.data/` in the repo). To use Postgres instead, see
`docker/docker-compose.postgres.yml` and the note in
`packages/db/prisma/schema.prisma`.

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
(`xt-tunnel-<id>.service`) automatically.

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
  openssh-client sshpass tar gnupg systemd ufw openssl iproute2`), Node ≥ 22,
  and `backhaul` / `frp` / `gost` binaries into `/var/lib/xistance/bin`.
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

## Example configs

Working TOML / command examples for each relay live in `tunnels/examples/`
(`backhaul-foreign.toml`, `backhaul-iran.toml`, `frp-frps.toml`, `frp-frpc.toml`,
`gost-relay.sh`, `ssh-tunnel.sh`). They mirror exactly what the panel generates.

## Commands

- `npm run dev` — dev server
- `npm run build` — production build (runs typecheck)
- `npm run lint` — ESLint
- `npm run typecheck` — TypeScript only

## Versioning

The panel version is shown in the footer (`Xistance Panel vX.Y.Z`, linking to the
GitHub repo) and is kept in sync across `package.json` files and
`apps/web/src/lib/version.ts` by `scripts/version.mjs`:

```bash
npm run version:show                 # print current version
npm run version:bump -- patch        # bump patch -> 1.0.1
npm run version:bump -- minor        # 1.1.0
npm run version:bump -- major        # 2.0.0
node scripts/version.mjs set 1.2.3   # exact version
node scripts/version.mjs patch --commit  # bump + git commit + tag vX.Y.Z
```

## CI/CD

- **`.github/workflows/ci.yml`** — runs `lint`, `typecheck` and `build` on every
  push/PR to `master`/`main`; uploads the standalone build as an artifact on push.
- **`.github/workflows/release.yml`** — manual `workflow_dispatch` that takes
  `patch`/`minor`/`major`, bumps the version, commits + tags `vX.Y.Z`, rebuilds,
  packages the standalone + static bundles, and creates a GitHub Release with
  auto-generated notes.

Push the repo to `https://github.com/insektdotbin/xistance-panel` to activate the
workflows.
