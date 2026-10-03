# TASK-73 verification evidence

Date: 2026-09-25
Scope: package a runnable Prisma client with the correct Linux native engine in the release artifact, and make the release gate reject artifacts that cannot boot.

## Root cause (diagnosed before any code)

Next standalone tracing copies **nothing** from `packages/db`:

- `required-server-files.json` contains `0` entries matching `packages/db`, `generated`, or `prisma`
- the standalone tree has no `node_modules/@prisma` and no `node_modules/@xistance`
- the only files present under `packages/db/generated/client/` were `query_engine-windows.dll.node` and `schema.prisma`, copied incidentally rather than traced

The app reaches Prisma through the workspace symlink `node_modules/@xistance/db -> ../../packages/db`, whose
`package.json` `main` points at a `.ts` source. Tracing resolves to TypeScript that has no runnable standalone
runtime path, so the JS entry points were never emitted into the artifact.

Consequence before this task: the release gate accepted an artifact that could not start on Ubuntu.

## TDD

- RED: `AssertionError: an artifact without a Prisma client must fail inspection` (`true !== false`), proving
  the gate accepted an unbootable artifact.
- Second RED during implementation, which is the more important one: inspection correctly rejected the tree,
  but staging threw first. The guarantee that actually matters is that no release directory is produced, so the
  test was corrected to assert staging rejects and leaves nothing behind.
- GREEN: `TASK73_TEST_EXIT=0`
  - `Release artifact inspection: incomplete, complete, forbidden, mismatch, Prisma runtime, staging, and CLI cases passed`

## What changed

`scripts/inspect-release-artifact.ts`
- added `RELEASE_LAYOUT.prismaClient`, `PRISMA_CLIENT_ENTRY_FILES` (`index.js`, `default.js`, `package.json`),
  and `PRISMA_LINUX_ENGINES` per architecture
- `inspectPrismaRuntime` requires the client entry points, rejects a foreign-platform engine, and requires an
  engine matching the requested architecture

`scripts/stage-release-artifact.ts`
- `stagePrismaClient` copies the client entry points and exactly the engine(s) valid for the target architecture
- any other `.node` engine in the staged payload is deleted, so an incidentally copied Windows engine cannot
  survive into a Linux release
- optional files are declared with an explicit `required` flag instead of a hand-listed allowlist
- the CLI now accepts `--architecture amd64|arm64` and forwards it

`.github/workflows/release.yml` passes `--architecture` to both staging and inspection.

## Real artifact verification (local, against the actual build)

The working tree's generated client contains **both** a Windows and a Linux engine, which made it possible to
prove the foreign-engine removal for real:

- `Release artifact inspection: PASS`, `Architecture: amd64`, `Checked files: 1964` (up from 1957)
- `Checksum verification: PASS`
- staged payload contains `index.js`, `default.js`, `client.js`, `edge.js`, `package.json`, `schema.prisma`,
  `query_engine_bg.js`, `query_engine_bg.wasm`, and `libquery_engine-debian-openssl-3.0.x.so.node`
- the archive contains `0` Windows entries

Before the fix, the same real run failed with:
`Prisma payload contains a foreign-platform engine for a Linux release: .../query_engine-windows.dll.node`

## Regression and quality gates

- `scripts/test-release-artifact.ts` — exit 0
- `scripts/test-release-workflow.ts` — exit 0
- `scripts/test-release-manifest.ts` — exit 0
- `scripts/test-release-assets.ts` — exit 0
- Release-script TypeScript check (nine scripts) — `SCRIPTS_TSC=0`
- `npm run lint` — `LINT=0`
- `npm run typecheck` — `TYPECHECK=0`
- `TURBO_DISABLE=true npx tsx scripts/test-optimizations.ts` — `Results: 77 passed, 0 failed of 77`

## Explicitly NOT yet proven

- **The artifact has not been started on Linux.** Every local verification ran on Windows. The Linux boot proof
  is step 4 of this task and is still open, so `TASK-73` is not passed yet.
- arm64 packaging is unverified; only the amd64 engine path was exercised.
- Ubuntu 22.04 remains unverified.
- The verified VPS (Ubuntu 24.04.1, 1 vCPU, 961 MB RAM, amd64) is the intended target for the boot proof.

## Scope and privacy notes

No real secret values, database contents, keys, or tokens were written to evidence. Nothing was pushed, tagged,
published, or committed, and existing unrelated worktree changes were preserved.
