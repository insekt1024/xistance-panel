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

> **Reverse tunnels: one setting on the foreign server.** A reverse tunnel asks
> the foreign server's SSH daemon to open the port for the whole internet. By
> default OpenSSH refuses and binds it to `127.0.0.1` only — and it does this
> silently: the `ssh` process stays alive and the port *is* listening, so a naive
> check would call the tunnel healthy. Xistance probes the foreign host and
> reports such a tunnel as **degraded**, with the reason and this fix attached,
> rather than claiming it is running. On the *foreign* server:
>
> ```bash
> echo 'GatewayPorts clientspecified' | sudo tee /etc/ssh/sshd_config.d/xistance.conf
> sudo systemctl restart ssh
> ```
>
> Only needed for **Reverse** and for **SSH** tunnels in `-R` mode.

## Install on a server (Ubuntu 22.04 / 24.04)

Two things travel to your server, and it is worth keeping them apart:

| What | Where it comes from | What it is |
| --- | --- | --- |
| **Application artifact** | Downloaded and verified by the installer | A prebuilt, immutable release: the panel server, its dependencies, static assets, database schema, migrations, and the Prisma query engine for your architecture. Nothing is compiled on the host. |
| **Tunnel binaries** | Fetched separately, on first use, per tunnel method | `xray`, `frp`, `gost`, `backhaul` and friends. These are per-method executables the panel manages under the data directory; they are not part of the application artifact. |

**Runtime prerequisites** on the host: `curl`, `tar`, and **Node.js 22** or
newer. Nothing else — no `npm ci`, no `next build`, no compiler, no
`prisma generate`.

Supported: Ubuntu **22.04** and **24.04**, on **amd64** (x86_64) and **arm64**.
Any other architecture is refused rather than guessed at.

### Recommended — one line, zero build, prebuilt artifact

The whole install is a single command. It downloads and verifies a pinned,
prebuilt release — no build runs on your server:

```bash
curl -fsSL https://raw.githubusercontent.com/insekt1024/xistance-panel/master/scripts/bootstrap.sh \
  -o /tmp/xp-install.sh && sudo bash /tmp/xp-install.sh --release --version v1.2.0 \
  --port 8080 --admin-email you@example.com
```

`--release` selects the prebuilt artifact path and `--version` pins the exact
tag. Both are required: there is no floating `latest`, so the same command
always installs the same build and every install is auditable afterwards.

The equivalent, if you would rather see each file before it runs:

```bash
curl -fsSL https://raw.githubusercontent.com/insekt1024/xistance-panel/v1.2.0/scripts/release-install.sh \
  -o /tmp/xistance-release-install.sh
curl -fsSL https://raw.githubusercontent.com/insekt1024/xistance-panel/v1.2.0/scripts/lib/release-layout.sh \
  -o /tmp/release-layout.sh
curl -fsSL https://raw.githubusercontent.com/insekt1024/xistance-panel/v1.2.0/scripts/lib/service-unit.sh \
  -o /tmp/service-unit.sh
sudo bash /tmp/xistance-release-install.sh --version v1.2.0
```

The version is **pinned on purpose** — there is no `latest` default, so the
same command always installs the same build. The installer detects `amd64` vs
`arm64` for you.

Useful options:

| Option | What it does |
| --- | --- |
| `--version <TAG>` | **Required.** Exact release tag, e.g. `v1.2.0`. |
| `--arch <ARCH>` | Override architecture detection (`amd64` or `arm64`). |
| `--archive <FILE>` | Install a pre-downloaded artifact instead of fetching one. The `.sha256` sidecar must sit beside it. This is the air-gapped path. |
| `--install-dir <DIR>` | Release root (default `/opt/xistance`). |
| `--data-dir <DIR>` | Mutable data, logs and tunnel binaries (default `/var/lib/xistance`). |
| `--dry-run` | Print the plan and change nothing. |
| `--keep-download` | Keep the downloaded artifact for inspection. |

To see exactly what it would do first:

```bash
sudo bash /tmp/xistance-release-install.sh --version v1.2.0 --dry-run
```

### What the installer actually does

1. **Verifies before it extracts.** The archive's SHA-256 is checked against the
   `.sha256` sidecar, and the embedded `release-manifest.json` must agree on
   version, architecture and payload digest. An artifact whose integrity cannot
   be proven is refused.
2. **Applies migrations.** Idempotent, and refuses to continue if an applied
   migration's checksum has drifted. The panel runs as an unprivileged service
   account, never as root.
3. **Ensures an administrator exists.** Created on first install only. If you
   ever lose the password:

   ```bash
   sudo node /opt/xistance/current/create-admin.mjs \
     --database /var/lib/xistance/app.db \
     --email admin@xistance.local \
     --password 'YOUR_NEW_PASSWORD' --reset-password
   ```

4. **Deploys into an immutable, versioned directory.** Each install lands in
   `/opt/xistance/releases/<tag>`, which is never modified in place. Static
   assets (`public/` and `.next/static/`) ship inside the artifact, so a release
   is self-contained.
5. **Cuts over atomically.** A single `current-release.txt` pointer plus a
   `current` symlink are replaced by rename, so a reader always sees either the
   old release or the new one — never a half-written state.
6. **Health-checks and rolls back.** The service is started, `/api/health` must
   report `database: ok`, and only then is the install called a success. If the
   health check fails, the previous release stays active and the candidate is
   retained for diagnosis.

### Rollback

A successful install keeps the previous release. To go back:

```bash
sudo xt-rollback /opt/xistance/releases/<previous-tag>
sudo systemctl restart xistance
curl -s http://127.0.0.1:8080/api/health
```

### Updating

To move to a newer release, run the same installer with the **new** tag:

```bash
sudo bash /tmp/xistance-release-install.sh --version v1.2.0
```

There is no floating `latest`: you always name the exact release you want, so
an update is the same audited command as the first install. Run it with
`--dry-run` first if you want to see the plan.

An update takes a backup of the mutable data directory, deploys the new version
alongside the old, health-checks, and rolls back on failure. It never builds
from source on the server.

### Backing up

Mutable state lives outside the release directories, so a backup is a copy of
the data directory:

```bash
sudo tar czf xistance-backup-$(date +%F).tar.gz -C /var/lib/xistance .
```

Release directories are immutable and reproducible from the artifact; only
`/var/lib/xistance` (database, logs, tunnel binaries) needs backing up.

#### The in-app export (Settings -> Backup) redacts tunnel credentials

This is not the same thing as the `tar` above, and the difference matters.

A filesystem backup copies the database file, so node credentials travel as
ciphertext and need only `XTENC_KEY` to be readable. A **tunnel config cannot be
encrypted that way** — the engine has to hand the token to a process at start
time, so it is stored in plaintext. Exporting it verbatim would put every
BACKHAUL/FRP token, FRP `secretKey`, SSH key and password, and 3X-UI password in
your download — and then in whatever you do next with it.

So the export masks those fields (`***`). The trade-off is deliberate:

- **A restored backup keeps tunnel structure, not tunnel credentials.** Node
  credentials do restore, since they are ciphertext.
- **Re-enter the credential** for any tunnel that needs one after restoring onto
  a different install.
- A `tar` of `/var/lib/xistance` is still the complete backup. Use the in-app
  export for moving *configuration*, not for migrating live credentials.

The same reasoning is why the export is `SUPER_ADMIN` and audit-logged.

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

### Verifying a downloaded release

Every release publishes an archive plus a `.sha256` sidecar. **Verify the
checksum first** — it is the only check that works for every download, and it
is the one the installer performs:

```bash
sha256sum --check xistance-panel-v<version>-<arch>.tar.gz.sha256
```

You can also verify an artifact before installing it, without deploying it:

```bash
npx tsx scripts/verify-artifact.ts xistance-panel-v1.2.0-amd64.tar.gz
```

That checks the checksum, the manifest, and the archive layout, and rejects
absolute paths, `..` traversal, symlinks and secret-looking file names.

If the repository publishes a provenance attestation, you can additionally
confirm the archive was built by this project's release workflow:

```bash
gh attestation verify xistance-panel-v<version>-<arch>.tar.gz --repo insekt1024/xistance-panel
```

That step needs the `gh` CLI and a token with read access, and it is skipped on
repositories where GitHub attestations are not enabled. **An attestation proves
where and by which workflow the artifact was built. It does not prove the code
is safe** — it is an addition to the checksum, never a replacement for it, and
never a substitute for reviewing the release notes.

### Low-resource hosts

Measured on a 1 vCPU / 961 MB host: health responses average ~21 ms, login-page
loads ~39 ms, and the running service sits near 117 MB RSS. The install runs no
`npm` process at all, which is the main reason it fits — a source build on the
same host is what previously ran the machine out of memory.

### Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `path is not absolute` from systemd | The unit file was edited and its directives were quoted. `EnvironmentFile` and `WorkingDirectory` must be unquoted. |
| `set: pipefail: invalid option name` | The install script has Windows (CRLF) line endings. Re-download it. |
| `database: unreachable` in `/api/health` | Migrations did not apply. Check `sudo journalctl -u xistance`. |
| Login returns 401 with the right password | The admin row is missing or the password was reset. See the recovery command above. |

### Alternative — source checkout and build

If you want the panel built on the server from source, ask for it explicitly.
This needs more RAM and time than the prebuilt path above:

```bash
curl -fsSL https://raw.githubusercontent.com/insekt1024/xistance-panel/master/scripts/bootstrap.sh \
  -o /tmp/xp-install.sh && sudo bash /tmp/xp-install.sh --source --port 8080 \
  --admin-email you@example.com
```

Then open `http://<your-server-ip>:8080` and log in.


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
