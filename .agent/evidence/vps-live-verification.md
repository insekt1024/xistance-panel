# Live VPS verification — the zero-build artifact on real Ubuntu

**Status:** PASSED. This is the first time `/api/health` has returned healthy on
a real artifact from a real server.

Host: Ubuntu 24.04.1 LTS, x86_64, 1 vCPU, 961 MB RAM, 3.7 GB free disk,
Node v22.23.2. Credentials `[REDACTED]`; the password was passed via a
transient file and never written to source, evidence, or logs.

## What was verified

| Step | Result |
| --- | --- |
| `node:sqlite` on the host | Works (`NODE_SQLITE_OK value=hello`) |
| Artifact upload + SHA-256 | `xistance-panel-v1.1.2-amd64.tar.gz: OK` |
| Extraction | `EXTRACT_OK` |
| Runtime files present | `server.js`, `apply-migrations.mjs`, `create-admin.mjs`, `migrations/` |
| Prisma engine | `libquery_engine-debian-openssl-3.0.x.so.node` (correct for amd64/glibc) |
| Static assets | CSS present in the extracted tree |
| Migrations | `applied 20260823214332_init` |
| `Tunnel` queryable | **YES** — the exact query that failed with `P2021` before |
| Migration idempotency | re-run: `0 applied, 1 total` |
| Admin creation | `created super admin: smoke@xistance.local` |
| **Health** | `{"ok":true,"status":"healthy","checks":{"database":"ok","engine":"ok"}}` |
| Redirect chains | `/login` 200 in 2 hops, `/en/login` 200 in 1, `/fa/login` 200 in 1 |
| Assets referenced by login | 8/8 returned 200 with correct MIME types |

## The locale loop is fixed in production

Before the fix, `/login` answered `307 → /login` forever. Now every entry point
terminates:

```
/login       -> 200 after 2 hop(s)  TERMINATES
/en/login    -> 200 after 1 hop(s)  TERMINATES
/fa/login    -> 200 after 1 hop(s)  TERMINATES
```

## Performance on the target hardware (measured, not invented)

| Measurement | Result |
| --- | --- |
| 200 sequential `/api/health` | 200 ok, 0 failed, 4134 ms total |
| Mean per health request | **~20.7 ms** |
| 100 login-page loads (HTML + assets) | 100 ok, 0 failed, 3919 ms |
| Mean per page load | **~39.2 ms** |
| Server RSS | 128.5 MB idle, 143.1 MB under load |
| Server CPU | 16% during the load phase |
| Host memory used | 520 MB of 961 MB |
| Still listening afterwards | yes |

## The zero-build claim is now evidenced

The host's only OOM kill in its entire uptime was:

```
[Sun Sep  6 13:31:37 2026] Out of memory: Killed process 35894 (npm ci)
anon-rss:317952kB
```

That is a `npm ci` — i.e. exactly the build-chain step the release design
eliminates. There have been **zero** OOM kills in the last 24 hours and none
since. The panel itself runs in 143 MB, and no `npm` process ran at all during
installation: the artifact was downloaded, checksum-verified, extracted,
migrated and started with no build step. This is the concrete evidence the PRD
asked for on a 1 vCPU / 961 MB host.

## Note on `node:sqlite`

It works on Node v22.23.2 but emits:

```
ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

The warning appears on stderr during migration and admin creation. It is
harmless, but it will be visible in installation logs, and `node:sqlite` is not
covered by semver stability guarantees. A future Node major could change it.

## Recorded gaps

1. **Not a real install.** The artifact was extracted and run directly; the
   one-line `release-install.sh` path (download → verify → versioned dir →
   systemd → activate) has **not** been exercised on this host.
2. **systemd, the `xistance` service account, and `ProtectSystem=full` are
   untested here** — the server was started directly.
3. **No tunnel method was created or run.** The nine methods remain unverified.
4. **No authenticated flow.** The admin exists but no login was performed, so
   the authenticated dashboard and its assets are unproven.
5. **No HTTPS/TLS, firewall, or `XT_TRUST_PROXY` behaviour tested.**
6. **Version is still 1.1.2**, not the 1.2.0 target.

## Next concrete step

Run the actual one-line installer on this host against a real published release,
which closes gaps 1–3 at once.
