# Xistance Panel 1.2.0 — Product Summary

Xistance Panel 1.2.0 is a self-hosted bilingual control panel for reverse tunnels across a panel VPS and remote nodes. It preserves the existing nine tunnel methods while making lifecycle state truthful, installation reproducible, updates reversible, and operation practical on Ubuntu 22.04/24.04 hosts with one vCPU and low RAM.

## Main Features

- Manage nodes, tunnels, port forwards, users, activity, audit records, tools, webhooks, settings, logs, events, and traffic in English and Persian.
- Stabilize `BACKHAUL`, `FRP`, `GOST`, `SSH`, `PORT_FORWARD`, `DIRECT`, `REVERSE`, `XRAY`, and `XUI` with configuration, lifecycle, reconnect, cleanup, error, and resource evidence.
- Publish a prebuilt, architecture-specific immutable artifact with embedded static assets and no build step on the VPS.
- Install with one pinned command; verify checksum/provenance, back up state, deploy beside the active version, cut over atomically, check readiness, and roll back safely.
- Preserve session/origin, CSRF/rate-limit, SSRF, SSH allowlist, systemd sanitization, and encrypted-secret controls.
- Meet WCAG 2.2 AA for representative final UI routes and distinguish panel, node, process, and probe health.
- Update `README.md` and `README_FA.md` with the actual artifact, commands, prerequisites, troubleshooting, and release evidence.

## Key User Flows

1. Install with a version-pinned one-line command and reach readiness without `npm install` or `next build` on the VPS.
2. Log in, add/test a node, and create a validated tunnel using one of the nine existing methods.
3. Start/stop/reconnect a tunnel, inspect truthful state/logs/events, and recover from failures.
4. Back up, update, verify readiness, and roll back or restore when needed.
5. Build, attest/checksum, inspect, test on a real Ubuntu VPS, and publish only after release gates pass.

## Key Requirements

- Release target: `1.2.0`; no breaking API, Prisma schema, or UX change without explicit approval.
- Supported hosts: Ubuntu 22.04/24.04, one vCPU, low RAM; baseline and before/after measurements are required.
- No new tunnel method in 1.2.0 unless a benchmark, threat model, and independent test plan justify it.
- No real secrets or production data in source, tests, artifacts, logs, screenshots, documentation, or chat.
- `README.md` and `README_FA.md` must describe the final artifact and be updated together.
- Automated baseline: `npm run version:check`, `npm run lint`, `npm run typecheck`, `TURBO_DISABLE=true npx tsx scripts/test-optimizations.ts`, and `TURBO_DISABLE=true npm run build`.
- Docker verification is an explicit environment gap until a Docker daemon is available; it is not silently reported as passing.
- Release is blocked by any unresolved critical/high security issue, required static-asset failure, failed method evidence, failed VPS install/update/rollback drill, or undocumented waiver.
