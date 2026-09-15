<p align="center">
  <img src="docs/xistance-logo.svg" alt="Xistance Panel official logo" width="128" />
</p>

<h1 align="center">Xistance Panel</h1>

<p align="center">
  Connect your <strong>Iran server</strong> to your <strong>foreign server</strong>
  so your websites and services stay reachable — no networking degree required.
</p>

<p align="center">
  <a href="README_FA.md">🇮🇷 راهنمای فارسی</a>
</p>

<p align="center">
  <a href="https://github.com/insekt1024/xistance-panel/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/insekt1024/xistance-panel/actions/workflows/ci.yml/badge.svg" /></a>
  <a href="https://github.com/insekt1024/xistance-panel/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/insekt1024/xistance-panel" /></a>
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-black" />
  <img alt="Prisma" src="https://img.shields.io/badge/Prisma-6-2D3748" />
</p>

## What is this?

You have two servers: one in **Iran** and one **outside Iran**. Internet
restrictions can make it hard to reach services running in Iran from outside
(or the other way around). Xistance Panel is a simple web page that joins the
two servers with a secure **tunnel**, so traffic flows through even when a
direct connection does not work.

You manage everything from your browser: add your servers, pick a tunnel
type, press deploy. The panel installs, starts, monitors and restarts the
tunnel for you.

## Which tunnel do I need?

| Tunnel | Use it when… |
| --- | --- |
| **Reverse** (recommended) | Your Iran server is behind a firewall/NAT. Iran connects *out* over SSH (`-R`, TCP), so nothing needs to be opened in Iran. |
| **Direct** | Both servers can reach each other directly. Simplest option, one server only. |
| **Backhaul** | You want the fastest reverse tunnel with extra tuning (multiplexing, congestion control). |
| **FRP** | You need many ports/protocols or HTTP routing from one tunnel. |
| **GOST** | You want a tiny, fast TCP/UDP relay. |
| **SSH** | You already think in SSH (`-L` / `-R` / SOCKS). Auto-reconnects on drops. |
| **Xray** | You have a VLESS / VMess / Trojan / Shadowsocks inbound (for example in 3X-UI) and want the panel to run it. |
| **X-UI / 3X-UI** | Your config already lives in an X-UI / 3X-UI panel — link it and let Xistance watch it. No extra software runs. |
| **Port Forwarding** | "Open port X here, send it to service Y there." Fully **automatic** by default: just point at your service and the panel picks a free port. Switch to Advanced to choose the port yourself. |

## Install on a server (Ubuntu 22.04 / 24.04)

One line. The installer asks you 2–3 questions (port, admin email) and does
the rest: system packages, Node 22, tunnel programs (`backhaul`, `frp`,
`gost`, `xray`), database, and a service that starts on boot.

```bash
curl -fsSL https://raw.githubusercontent.com/insekt1024/xistance-panel/master/scripts/bootstrap.sh \
  -o /tmp/xp-install.sh && sudo bash /tmp/xp-install.sh
```

Then open `http://<your-server-ip>:8080` and log in.

Small/cheap server? No problem: on hosts with less than ~1.5 GB RAM the
installer adds swap automatically and builds in low-memory mode, and X-UI
linked tunnels run zero extra processes.

### Behind a reverse proxy or a custom domain

The panel accepts browser requests whose `Origin` matches the address the
browser used, so opening it directly at `http://<server-ip>:8080` needs no
configuration. Two knobs cover the less usual setups — add either to
`/etc/xistance/xistance.env` and `systemctl restart xistance`:

| Variable | When you need it |
| --- | --- |
| `XT_TRUST_PROXY=true` | Nginx / Caddy / Cloudflare in front. Lets the panel read `X-Forwarded-Host` and `X-Forwarded-For`. Only set this when a proxy really is in front — the headers are forgeable otherwise. |
| `XT_ALLOWED_ORIGINS=https://panel.example` | The public address differs from the `Host` the panel receives. Comma-separated; full origins or bare `host:port`. |

If actions fail with *"Cross-origin request rejected"*, one of these two is
what you are missing.

## Daily use (3 steps)

1. **Nodes** — add your Iran server and your foreign server (IP + SSH login).
   The panel tests the connection for you.
2. **Tunnels → New tunnel** — pick Iran + foreign, pick a tunnel type from
   the table above, fill the 2–3 fields, deploy.
3. **Done** — the dashboard shows status, traffic and logs. If a link drops,
   the panel restarts it.

## Xray + X-UI / 3X-UI

- **Xray tunnel:** open your 3X-UI panel, copy the inbound's address, port and
  UUID/password into the Xistance wizard. The panel writes the `xray.json`
  config and runs `xray` for you (see `tunnels/examples/xray-vless.json`).
- **X-UI link:** enter the 3X-UI panel address + username + password
  (optionally an inbound ID). The panel checks the login over HTTPS and keeps
  watching it. Nothing is installed for this type.

## For developers

```bash
npm install
cp apps/web/.env.local.example apps/web/.env.local
npm run dev          # http://localhost:3000
```

Checks (same order as CI): `npm run version:check` → `npm run lint` →
`npm run typecheck` → `npx tsx scripts/test-optimizations.ts` →
`TURBO_DISABLE=true npm run build`.

Do not edit `apps/web/src/lib/version.ts` by hand — bump with
`node scripts/version.mjs patch|minor|major|set X.Y.Z [--commit]`.

Working config examples for every tunnel live in `tunnels/examples/`.
Production run uses the standalone server:
`node apps/web/.next/standalone/apps/web/server.js` (`next start` is invalid
with `output: "standalone"`).

## Help

- 🇮🇷 Full Persian guide: [README_FA.md](README_FA.md)
- Issues: https://github.com/insekt1024/xistance-panel/issues
