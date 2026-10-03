# TASK-1 prerequisite verification evidence

Date: 2026-09-25
Scope: verify repository, local environment, required runtime, test access, and release prerequisites are available. No secret values are recorded here.

## 1. Repository root and branch

- Root: `E:/codes/Projects/Xistance-Tunnel/xistance-panel`
- Branch: `master`, HEAD `8e366d8`
- The worktree contains pre-existing uncommitted user changes. They were preserved; no reset, clean, or checkout was performed.

## 2. Local environment

- Node `v22.23.2`, npm `10.9.8`, Git `2.52.0`
- `node_modules` present; workspaces installed
- GitHub CLI authenticated (status checked without printing tokens)
- Browser automation helper available
- Docker CLI present, daemon **unavailable** in this environment

## 3. Local environment template

- `apps/web/.env.local` exists and is user-managed. Only variable names were inspected; no value was read, printed, or recorded.
- `apps/web/.env.local.example` was expanded with `TODO_FILL_MANUALLY` placeholders as part of `TASK-4`.

## 4. Real Ubuntu VPS access — now verified

The previously blocked VPS prerequisite has been supplied and verified end to end.

- Host: `45.82.136.139`, SSH port `2222`, user `root`
- Host key pinned and **verified independently** before any credential was used. The ed25519 fingerprint
  `SHA256:surzUG5XQL+taTWZ8sL7kwQ3JG5YxuYFWORs+iElfpw` was obtained from `ssh-keyscan` and confirmed
  identical to the fingerprint reported by the SSH client.
- Server banner: `SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.19`
- OS: **Ubuntu 24.04.1 LTS**, kernel `6.8.0-139-generic`, architecture `x86_64` (amd64)
- CPU: **1 vCPU** (`nproc` = 1)
- Memory: **961 MB total**, 597 MB used, 363 MB available at time of check
- Disk: 23 GB total, 17 GB used, **5.6 GB available**
- Node `v22.23.2` already installed at `/usr/bin/node`
- Docker: **absent**

This host matches the PRD target profile for Ubuntu 24.04, 1 vCPU, low RAM, amd64, which is exactly the
configuration the zero-build release must survive.

Credential handling: the password was supplied only through process input to the SSH client and a transient
password file, which was deleted in the same command and verified deleted. It was never written to the
repository, to evidence, to logs, or to a persistent config file. The host key was pinned by fingerprint, so
future connections are not silently trusting an unverified key.

### Disposition of the previously blocked items

- `TASK-62/63/64/65` (Ubuntu VPS acceptance) are **no longer blocked on access**. They remain gated on real
  work: Prisma packaging (below) and the installer/update path.
- Only **Ubuntu 24.04 / amd64** is available. Ubuntu 22.04 and arm64 acceptance are still unverified and must
  not be represented as passing.
- Docker-dependent verification remains **unverified** and must not be represented as passing. The host has no
  Docker, and the selected release path is independent of Docker.

## 5. Documentation and disposable test data

- Bilingual README files `README.md` and `README_FA.md` exist and are tracked as in-progress.
- No disposable test account or seeded fixture has been created yet. That remains open.
- No credential, token, or key is stored in the repository; real values stay in local/VPS configuration only.

## 6. Outstanding prerequisite risk: Prisma is not packaged for Linux

Verified during `TASK-8` and re-confirmed on the real build output: the standalone release tree contains only
`query_engine-windows.dll.node` and `schema.prisma` under `packages/db/generated/client/`. It is missing
`index.js`, `package.json`, and any Linux engine. The working tree has these files, so this is a Next
standalone tracing gap rather than a missing generate step.

Consequence: an artifact produced today **cannot start on this VPS**. This blocks zero-build acceptance and
must be fixed before any install, health, or load test on the host. It is a release blocker, not a test gap.

## 7. Gate decision

- Proceed with local implementation and with VPS access.
- Proceed to install/boot testing only after Prisma runtime packaging is fixed; otherwise the test would fail
  for a known and already-diagnosed reason.
- Do not claim Ubuntu 22.04, arm64, or Docker verification.
