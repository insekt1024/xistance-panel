# Xistance Panel 1.2.0 Product Requirements Document

**Status:** Approved for implementation  
**Date:** 2026-09-24  
**Repository:** `xistance-panel`  
**Source of truth:** This PRD, approved product decisions, repository manifests/configuration, current uncommitted work, and verified baseline commands.

## 1. Executive Summary

Xistance Panel 1.2.0 is a self-hosted bilingual Web UI for managing reverse tunnels across a panel VPS and remote nodes. It must stabilize the existing nine tunnel methods, deliver truthful operational state, reduce resource use on Ubuntu 22.04/24.04 VPS hosts with one vCPU and low RAM, and ship as a prebuilt immutable release artifact with embedded static assets, zero-build installation, one-line installation, and safe update/rollback. Existing API, database, and UX compatibility remain the default; release 1.2.0 must not introduce breaking changes.

The product is not “bug-free” by assertion. Release acceptance requires a recorded baseline, passing automated checks, browser smoke coverage, security verification, and a real Ubuntu VPS test covering installation, health, startup, tunnel health, and representative load. Any unmet criterion blocks release or is explicitly waived by the product owner with a named risk and mitigation.

## 2. Problem Statement

The current application already contains a substantial Next.js/Prisma panel, nine tunnel methods, deployment/configuration security helpers, bilingual UI, optimization code, and a custom verification harness. The remaining release risk is not a lack of broad features; it is the distance between locally passing code and a reliable, low-resource production installation. The panel must be verifiable end-to-end, provide actionable diagnostics instead of optimistic state, make updates reversible, and ship documentation matching the actual artifact and supported environments.

## 3. Goals

1. Make all nine existing methods demonstrably reliable: `BACKHAUL`, `FRP`, `GOST`, `SSH`, `PORT_FORWARD`, `DIRECT`, `REVERSE`, `XRAY`, and `XUI`.
2. Establish a reproducible baseline for correctness, security, UI, resource use, and installation on Ubuntu 22.04/24.04 with one vCPU and low RAM.
3. Release a prebuilt, architecture-specific artifact containing the app runtime, Next standalone output, static assets, and required runtime dependencies; the VPS performs no source build.
4. Add low-risk operational capabilities such as diagnostics, health telemetry, backup/restore, and safe recovery only when covered by tests and measurable acceptance criteria.
5. Keep existing security boundaries: session/CSRF validation, SSRF/private-network protection, SSH option allowlisting, systemd directive sanitization, and encrypted secret storage.
6. Provide a trustworthy bilingual product surface: `README.md` and `README_FA.md` must describe the final artifact, installation, methods, configuration, troubleshooting, backup/recovery, resource guidance, and release verification.
7. Meet WCAG 2.2 AA for the final user-facing UI, including keyboard access, visible focus, accessible names/errors, contrast, target sizing, responsive/reflow behavior, reduced motion, and correct English/Persian directionality.

## 4. Non-Goals and Scope Boundaries

- No new tunnel method in 1.2.0 unless later justified by a benchmark, threat model, and independent test plan. The nine existing methods remain the release scope.
- No breaking API, Prisma schema, or UX change. If a discovered defect makes a breaking change unavoidable, stop and obtain a product-owner decision before implementation.
- No promise of absolute bug freedom. Acceptance is measured and evidenced.
- No claim of self-contained execution without Node.js 22. `next start` remains invalid; production uses the standalone `server.js`.
- No real tunnel traffic or real secrets in tests, fixtures, logs, documentation examples, PRD files, or CI output.
- No source build, `npm install`, or `next build` on the target VPS. Node.js 22 runtime and OS-level tunnel binaries are prerequisites/prerequisites-to-package, not evidence of a zero-dependency executable.
- Docker verification is unavailable in the current environment unless the prerequisite changes. It is tracked as an environment gap, not silently treated as passing.

## 5. Target Users and Operating Constraints

- Ubuntu 22.04 LTS and Ubuntu 24.04 LTS hosts.
- One vCPU, low RAM, potentially constrained disk and network, and swap available when needed.
- Both `amd64` and `arm64` are required for the release artifact, subject to an explicit feasibility gate. The gate is defined and owned by **TASK-3** ("Define supported release architecture and runtime contract", step 4), not TASK-1. **Gate outcome: FEASIBLE** — Prisma `6.19.3` publishes native `linux-arm64-openssl-3.0.x` query engines (engines commit `c2990dca591cba766e3b7ef5d9e8a84796e47ab7`), verified against `binaries.prisma.sh` with an x64 control. `arm64` is therefore a required target. Building and testing the arm64 artifact remains a separate, unmet release gate; see `.agent/evidence/task-77-arm64-feasibility-gate.md` and `.agent/evidence/release-contract.md`.
- The panel is expected to run as a systemd-managed service behind an optional trusted reverse proxy.
- Operational documentation and diagnostics must distinguish panel-node health from remote tunnel-process health and the probe result of a particular protocol.

## 6. Release Contract: Prebuilt Immutable Artifact

### 6.1 Artifact definition

For each supported architecture, CI produces one versioned artifact (for example, a `.tar.gz` archive) containing:

- the built web application and its traced runtime dependencies;
- the Next standalone `server.js` and required server assets;
- `.next/static` and `public` assets in the locations expected by the standalone server;
- the forwarder/sidecar or required tunnel binaries, or explicit managed OS packages, with their licenses and pinned versions;
- a version manifest, architecture, release commit, and content checksums;
- a service template and migration command contract, but no secret values, databases, logs, or local development state.

The artifact is built only in CI/release. The installer does not compile source or run `npm install`.

### 6.2 Embedded static assets

The release builder must explicitly copy `public` and `.next/static` into the standalone tree in their required locations. Smoke tests must load a protected localized route, load its JS/CSS/media assets, and fail on missing assets, MIME failures, or an unprotected panel shell.

### 6.3 Immutable deployment and rollback

- Each release uses a unique, versioned directory and unique artifact digest.
- The installer verifies checksum and, where available, release provenance before extraction.
- A new release is installed beside the active release, then switched with an atomic symlink/service cutover.
- The previous release and its manifest remain available for rollback.
- An already published artifact is not overwritten or edited in place.

### 6.4 One-line installer

A version-pinned command downloads only the correct architecture artifact, verifies it, backs up mutable state, extracts to a new release directory, installs the service, performs readiness checks, and reports an actionable error. It must not require the user to edit source, compile, or manually assemble the artifact.

## 7. Existing Product Features to Preserve and Complete

- Localized login, dashboard, nodes, tunnels, port-forwarding, users/activity, audit, tools, webhooks, and settings surfaces.
- CRUD, import, batch operations, actions, logs, events, and traffic views for the supported resources.
- Node connectivity testing and tunnel configuration validation.
- Current rate limiting, query caching, pagination, audit logging, backup export, health endpoint, and metrics endpoint.
- Current Prisma SQLite default, optional PostgreSQL path, encryption-at-rest helpers, and tunnel process supervision.
- English and Persian catalogs kept in sync.
- Existing Docker path as a supported development/deployment path, subject to a Docker-enabled verification job.

## 8. Reliability and Method Workstreams

Each method receives a shared reliability contract and method-specific checks. A method is complete only when configuration parsing, command/config generation, lifecycle start/stop, process state, reconnect behavior, error reporting, cleanup, and resource use are tested. Method tests must distinguish local control-plane state from remote node/process state.

### 8.1 Shared engine contract

- Idempotent start/stop operations and bounded shutdown.
- No orphan child processes or stale systemd units after stop, update, failure, or restart.
- Truthful `running` state based on process/systemd evidence.
- Bounded retries with jitter, clear terminal failure, and no tight retry loop.
- Structured logs/events for start, stop, retry, restart, failure, and cleanup.
- Cache TTLs and concurrent reconcile operations cannot make state permanently stale.
- Port allocation is bounded, handles races, and reports exhaustion.
- Shutdown and recovery do not block the event loop.

### 8.2 Method-specific requirements

- `BACKHAUL`: validate transport/auth/config; verify client/server lifecycle, reconnect, and no secret leakage.
- `FRP`: validate TOML and supported transport options; verify dashboard/status, start/stop, reconnect, and config reload boundaries.
- `GOST`: verify binary discovery, command generation, process lifecycle, cleanup, and constrained-host behavior.
- `SSH`: preserve allowlisted options, monitor/gatetime behavior, destination validation, reconnect, and no shell-injection paths.
- `PORT_FORWARD`: preserve bounded reconcile/coalescing, free-port selection, grace periods, and truthful forwarding state.
- `DIRECT`: verify local listener ownership, port conflicts, bind address, stop cleanup, and error feedback.
- `REVERSE`: verify TCP-only remote listener behavior, remote address fallback, port conflicts, cleanup, and reconnect.
- `XRAY`: verify valid JSON configuration, inbound/outbound wiring, atomic config replacement, process restart, and secret redaction.
- `XUI`: verify controlled private-network exception, credential-free sync payload, API failure behavior, and bounded retries.

## 9. Performance and Low-Resource Acceptance

The exact target depends on the selected VPS, disk, network, and binaries. Acceptance is before/after comparison on the same host:

- installation reaches readiness on the target host with no build step;
- health endpoint and representative tunnel operations succeed without OOM;
- no more than 10% regression in the selected control-plane latency metrics versus the recorded baseline for the same workload;
- no unbounded memory growth during an agreed sustained test window;
- no tight retry loop, orphan process leak, or process restart storm;
- benchmark results record host class, RAM, swap, vCPU, architecture, artifact size, install time, startup time, idle/peak RSS, CPU, control-plane latency, tunnel health, and reconnect time.

The release owner must choose and record concrete numeric budgets after the baseline task. This PRD intentionally does not invent absolute throughput or latency numbers before measurement.

## 10. Security Requirements

- Preserve session and origin checks on all protected API routes; test absent, malformed, cross-site, and allowed origins.
- Preserve CSRF and rate-limit behavior; test refresh/login/setting/tool/node-test/action paths and bypass attempts.
- Keep SSRF and private-network protections; test literal private ranges, DNS/IP edge cases where supported, redirects, and the explicitly controlled XUI exception.
- Keep SSH extra arguments and systemd unit content allowlisted/sanitized; add regression tests for newline, quote, option, and environment injection.
- Never expose encrypted secrets, bearer tokens, passwords, connection strings, or private keys in API responses, logs, audit records, metrics, backups presented in UI, screenshots, or release notes.
- `XT_TRUST_PROXY` remains disabled by default and is documented as safe only behind a sanitizing reverse proxy.
- CI must use least-privilege permissions and pin third-party Actions to immutable commit SHA where practical.
- Artifact checksums and GitHub artifact attestations are mandatory if the repository setting supports them; artifact attestation does not replace checksum verification or security review.
- No new external integration or method is accepted without a threat model and negative tests.

## 11. UI, UX, and Accessibility Requirements

The final user-facing UI must meet WCAG 2.2 AA:

- every interactive control is keyboard operable with a visible focus indicator;
- controls have accessible names, roles, states, and programmatic error association;
- text and non-text contrast meet AA thresholds;
- controls meet minimum target-size requirements and remain usable at 200% zoom/reflow;
- dialogs and menus support Escape/close behavior, focus handling, and no keyboard trap;
- loading, empty, degraded, success, and error states are textually distinguishable and not color-only;
- English and Persian layouts set the correct `dir` and logical CSS direction; reduced motion is respected;
- destructive/irreversible operations use a clear confirmation and result feedback;
- dashboard states clearly distinguish panel health, node health, tunnel process state, and protocol probe result.

## 12. Competitive Landscape

Research snapshots (2026-09-24; verify again before release):

- **frp**: mature reverse-proxy engine supporting TCP/UDP/HTTP/HTTPS, auth, TLS, hot reload, monitoring, and plugins. It is a protocol/engine dependency, not a full Xistance-style multi-method panel.
- **rathole**: lightweight TCP reverse tunnel focused on simple self-hosted deployments; useful comparison for low-resource design, but does not provide the same multi-method control plane.
- **3X-UI**: feature-rich Xray management with many protocols, multi-node features, statistics, subscriptions, and a broad UI. It is not positioned as a lightweight zero-build panel for arbitrary low-RAM hosts; its current upstream warning about production use is relevant.
- **Smite / NetsGo / xray-pilot**: independent self-hosted panels showing competition around multi-method control, single-file/low-deployment claims, embedded UI, diagnostics, and self-healing. Their claims are comparison points, not acceptance evidence; verify licenses, maintenance, security, and resource claims independently.
- **Cloudflare Tunnel / ngrok**: hosted or vendor-managed alternatives with less host-level control but potentially better operational abstraction. Xistance remains focused on self-hosted control and explicit node/tunnel lifecycle.

## 13. Core User Flows

1. **Install:** one-line command → architecture selection → checksum verification → mutable-state backup → versioned extraction → service activation → readiness.
2. **First login:** localized login → secure cookie/session establishment → dashboard health summary.
3. **Add a node:** form validation → SSRF/credential protections → create node → test connectivity → save encrypted credentials.
4. **Create a tunnel:** choose method → validate method config → generate command/config → deploy → start → observe truthful state/logs/events → stop/cleanup.
5. **Diagnose:** dashboard status → node test → tunnel logs/events → process/systemd evidence → actionable remediation.
6. **Maintain:** backup → update to pinned version → migration/readiness → rollback on failure → restore/recovery drill.
7. **Release:** CI verification → prebuilt artifact → checksums/attestation → README consistency check → VPS smoke/load test → publish only when gates pass.

## 14. Documentation Requirements

Update both `README.md` and `README_FA.md` after implementation is verified, and keep their feature/method/environment/release instructions consistent:

- project overview and supported Node/OS/architecture;
- prebuilt zero-build artifact contract and one-line install/update/rollback commands;
- exact architecture selection and checksum/provenance verification;
- all nine methods, configuration, and status semantics;
- environment variable names and placeholders only;
- low-RAM/1-vCPU setup, swap/disk/network guidance, and diagnostics;
- backup/restore and migration behavior;
- common installation, auth, proxy, tunnel, database, and update failures;
- browser/API health smoke checks;
- release verification evidence and known limitations/waivers.

## 15. Success Metrics and KPIs

- 100% of automated baseline commands pass: version check, lint, typecheck, custom tests, and build.
- 100% of the nine methods have configuration, lifecycle, error, cleanup, and resource/reconnect evidence.
- 0 known critical/high security findings at release; 0 secret leaks in automated scans/log inspection.
- 0 required static-asset 404s in release smoke test; 0 unprotected panel-shell responses.
- 100% of supported architecture artifacts verify checksum and pass the artifact inspection.
- Installation/readiness and update/rollback drills pass on the real Ubuntu VPS.
- No more than 10% regression in selected low-resource control-plane latency metrics.
- UI acceptance includes WCAG 2.2 AA evidence for representative routes, not a claim without evidence.
- English and Persian documentation and catalogs are consistent with the shipped artifact.

## 16. Prerequisites and Access

### Required project inputs

- Repository access at `E:\codes\Projects\Xistance-Tunnel\xistance-panel`.
- Node.js 22, npm, and npm workspaces; local dependencies installed with `npm ci --no-audit --no-fund`.
- A real Ubuntu 22.04/24.04 VPS with one vCPU and low RAM, reachable through an approved test access path.
- A disposable test database and test users; disposable node/tunnel credentials; disposable local secrets.
- GitHub repository/release permissions for CI, checksums, and optional GitHub artifact attestation support.
- A browser automation runner and a process/systemd inspection path for VPS verification.
- Docker access only if the Docker release path remains in scope; otherwise record it as a deliberate non-blocking gap.

### Environment variable names

The following names were observed in the current source tree and must be represented in the project-local environment template with non-secret placeholders where a value is required. Never put real values in this PRD, task specs, logs, or chat.

Observed application/runtime names: `DATABASE_URL`, `JWT_SECRET`, `NEXT_RUNTIME`, `NODE_ENV`, `XTENC_KEY`, `XT_ADMIN_EMAIL`, `XT_ADMIN_PASSWORD`, `XT_ALLOWED_ORIGINS`, `XT_DATA_DIR`, `XT_DEMO`, `XT_ENV_FILE`, `XT_FORCE_NODE`, `XT_FORWARDER_SCRIPT`, `XT_KEY_DIR`, `XT_PANEL_HOST`, and `XT_TRUST_PROXY`.

The shell scripts also consume release/install variables such as version, architecture, repository, mirror, release URL, and installation directory. TASK-4 must verify the exact script-level names and add only the missing template/documentation entries; it must not invent values.