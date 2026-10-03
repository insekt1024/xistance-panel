# Xistance Panel Reliability, Performance, and Easier Tunneling Design

**Date:** 2026-09-24  
**Status:** Approved for implementation  
**Repository:** `xistance-panel/` (nested Git root)  
**Design direction:** Operational cockpit  
**Primary S1 flow:** Xray/X-UI wizard → API → engine → truthful persisted state  

## 1. Goal

Improve Xistance Panel across reliability, restricted-network usability, weak-VPS efficiency, and UI/UX without weakening its security boundaries or broad-rewrite scope. The work proceeds as measured, test-first vertical slices.

The target environment is a 1-vCPU/2-GB VPS running Node 22, with the existing low-memory safeguards preserved. Final restricted-network evidence must come from a live restricted-network environment; deterministic local simulations are pre-release evidence only.

## 2. Non-goals and invariants

- Do not rewrite the monorepo, tunnel engine, or 1,529-line wizard wholesale.
- Do not add a new test framework; extend `scripts/test-optimizations.ts` and its temp-SQLite setup.
- Do not weaken `isBlockedTarget`/`isPrivateIp`, `filterExtraArgs`, `sanitizeUnitText`, CSRF/session guards, or `XT_TRUST_PROXY` defaults.
- Do not make `next start` valid for standalone output; use the standalone server with explicit environment.
- Keep `TURBO_DISABLE=true`, dynamic Prisma imports, generated/runtime ignore boundaries, and en/fa catalog parity.
- Do not commit `.data/`, `tunnels/bin/`, `tunnels/tunnels/`, logs, keys, Prisma generated output, or machine-local agent state.
- Do not hand-edit `apps/web/src/lib/version.ts`; use `scripts/version.mjs`.
- Preserve pre-existing user-owned auth/session changes; ownership was explicitly transferred for integration, but each change remains separately reviewable.

## 3. Current architecture

```text
xistance-panel/
├── apps/web/
│   ├── app/[locale]/       localized pages and authenticated app shell
│   ├── app/api/            route handlers
│   ├── src/lib/             auth, DB access, engine adapter, cache, jobs, security
│   ├── src/components/      shared UI and Radix shims
│   ├── proxy.ts             next-intl locale middleware
│   └── instrumentation.ts   Node startup/recovery/jobs
├── packages/tunnel-core/    process, runner, builders, crypto, event bus
├── packages/db/             Prisma schema, migrations, seed, singleton
├── packages/types/          zod schemas and shared types
├── packages/i18n/           locale metadata and catalogs
└── scripts/                install, update, backup, version, custom tests
```

The current custom harness is the only test runner. It sets `DATABASE_URL`, `XT_FORCE_NODE`, `XTENC_KEY`, `JWT_SECRET`, and `NODE_ENV` before imports, creates `.data/test.db`, and dynamically imports `lib/api.ts` inside tests.

## 4. Scenario contract

### S1 — Xray/X-UI happy path

A signed-in user configures an Xray or X-UI tunnel in the real wizard. The API accepts a valid request, the engine creates the correct process/plan (XUI is metadata-only and has no process), the database and engine agree on a truthful state, and the UI does not report success after a failed operation.

**Evidence:** browser action log, `POST /api/tunnels` and action responses, `GET /api/tunnels` body, and Prisma row/state. Automated seam: new `T-S1-*` cases in `scripts/test-optimizations.ts`, each RED before implementation and GREEN after.

### S2 — Restricted/weak-network edge

A simulated timeout, DNS failure, reset, blocked target, and slow probe produce bounded, actionable responses. A live restricted-network run must confirm the same categories. Unsafe targets, credential-bearing URLs, raw SSH flags, and untrusted redirects remain rejected.

**Evidence:** local curl/CLI timing and response artifacts plus final live restricted-network artifact. Automated seam: `T-S2-*` cases for timeout/error taxonomy and batch collision behavior.

### S3 — Adjacent regression

Authentication/session behavior, all existing tunnel builders, lifecycle actions, cache namespaces, and security negative cases remain intact after every slice.

**Evidence:** full custom harness output, focused negative API responses, and engine/DB state comparison. Automated seam: existing tests plus `T-S3-*` regression cases.

## 5. Reliability architecture

### 5.1 Lifecycle serialization

Serialize operations per tunnel ID inside `TunnelEngine`. A deploy, start, stop, restart, remove, or synthetic port-forward operation for the same ID cannot interleave. The lock is released in `finally`; errors preserve the original cause.

### 5.2 Deploy rollback

Deployment owns every resource it creates. If planning, binary checks, file writes, process creation, or process start fails, dispose all handles created by the attempt, remove any partially written runtime state, invalidate lifecycle caches, and return a typed failure. The previous runtime is not silently discarded until replacement resources are ready, unless the existing contract explicitly requires replacement disposal.

### 5.3 Truthful state transitions

Engine actions and database updates must not silently diverge. If a database write fails after an engine mutation, attempt a compensating engine rollback and return a structured error. If an engine operation fails, the API must return a JSON error with an appropriate status and leave the persisted state consistent with the actual process state.

### 5.4 Process and runner errors

Preserve timeout, executable-not-found, authentication, and remote-command failure categories. Check `systemctl` exit codes. Prevent double-spawn with a single in-flight start promise. Bound forwarder shutdown by destroying active sockets rather than waiting indefinitely.

### 5.5 Startup and background jobs

Rehydrate persisted tunnels with bounded concurrency, never allowing one blocked node to prevent sampler/maintenance startup indefinitely. Reset sampler guards in `finally`; a failed snapshot must not permanently suppress later ticks. Keep shutdown flushing bounded and observable.

## 6. Restricted-network behavior

- Keep all probes behind authentication, CSRF, rate limits, and SSRF policy.
- Distinguish timeout, DNS failure, blocked target, authentication failure, and transport failure in user-facing messages.
- Use bounded timeouts and cancellation; do not add blind retries for auth or unsafe-input failures.
- Keep the XUI private/tailnet exception explicit, authenticated, rate-limited, HTTP(S)-only, credential-free in URLs, and manually redirected.
- Surface node test and diagnostic outcomes without exposing secrets or raw private configuration.
- Final S2 evidence requires a live restricted-network environment. If unavailable, development may continue with deterministic simulation, but the goal cannot be declared complete without that evidence or an explicit user-approved exception.

## 7. Weak-VPS performance policy

Measure before changing:

- install phases, npm cache, package build, Prisma generation, Next build, static copy, health time;
- runtime RSS/heap/external memory, sampler cadence, engine snapshot fan-out, log buffers, query latency, and cache hit behavior;
- 1, 10, 50, and 200 managed tunnel profiles where feasible.

The first optimization must be one bounded change with a regression guard. Do not alter Prisma engine/client strategy, SQLite pragmas, indexes, or polling without a reproduced bottleneck and before/after evidence. Preserve the existing automatic swapfile and low-memory build heap cap.

## 8. DESIGN.md contract

`xistance-panel/DESIGN.md` is created before any UI implementation. It defines:

1. research log and target users;
2. operational-cockpit visual intent;
3. color, typography, spacing, radius, elevation, and state tokens;
4. semantic status tokens for healthy, degraded, blocked, failed, pending, and unknown;
5. component primitives and their loading/empty/error/disabled/focus states;
6. responsive breakpoints and mobile table/card behavior;
7. RTL/logical-property rules and bidirectional host/value handling;
8. keyboard navigation, labels, focus return, and screen-reader status semantics;
9. motion rules using transform/opacity, reduced-motion support, and no decorative motion;
10. copy rules for English/Persian paired changes.

The first UI slice is intentionally narrow: language-switcher correctness, touched-view RTL logical properties, mirrored directional icons, labels/focus, and loading/empty/error states. It does not rewrite the wizard.

## 9. Execution waves

1. **Gate and design:** record decisions, create/review `DESIGN.md`, confirm live-network availability, keep dirty-file ownership explicit.
2. **S1 reliability:** RED tests → lifecycle mutex/rollback/truthful state → API/DB/browser evidence.
3. **S3 safety net:** process/runner/forwarder/security/cache/session regressions in disjoint slices.
4. **S2 restricted network:** batch collision, bounded diagnostics, actionable failures, security negatives, local then live evidence.
5. **Performance:** baseline, one bounded optimization or documented no-change, resource comparison.
6. **UI/UX:** DESIGN-gated minimal slice with en/fa parity and real browser checks.
7. **Documentation:** README and README_FA only after behavior stabilizes.
8. **Audit:** full CI order, build, standalone smoke, S1/S2/S3 artifacts, cleanup, and requirement review.

## 10. Verification and commit policy

Every production change follows:

1. add a focused failing test;
2. run it and capture the expected RED failure;
3. implement the smallest root-cause fix;
4. run focused and full relevant tests for GREEN;
5. exercise the real API/browser/DB/CLI surface;
6. inspect diagnostics and clean up spawned processes, ports, temp DBs, and test tunnels;
7. review the diff and commit only owned files atomically.

Final commands, in order: `version:check`, `lint`, `typecheck`, custom harness, `TURBO_DISABLE=true npm run build`, standalone-server smoke, browser QA, security review, and requirement audit.

## 11. Open dependencies

- Live restricted-network access is required for final S2 evidence.
- Exact design tokens and component-state details are finalized in `DESIGN.md` before UI edits.
- Weak-VPS acceptance uses same-machine baseline comparison rather than a universal absolute RSS/wall-time threshold.
- Pre-existing auth/session changes are now owned by this run but must remain isolated in reviewable commits.
