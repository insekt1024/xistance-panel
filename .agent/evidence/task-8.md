# TASK-8 verification evidence

Date: 2026-09-25
Scope: architecture-specific release artifacts in CI, gated on inspection and checksum verification.

## TDD

- RED: `npx tsx scripts/test-release-workflow.ts` failed with
  `AssertionError: release matrix must include the amd64 artifact; found: none`.
- GREEN: `TASK8_FOCUSED_EXIT=0`
  - `Release workflow: architecture matrix, staging, inspection, manifest, checksum, and publish order verified`

A second RED was captured for the payload digest contract in the TASK-7 suite
(`TypeError: treeDigest is not a function`) before `treeDigest` was implemented.

## What changed in the workflow

`.github/workflows/release.yml` was refactored from a single job into four jobs:

- `version` — bumps, verifies, and pushes commit + tag. Keeps `contents: write`.
- `artifact` — matrix `fail-fast: false` over `amd64` and `arm64`. Builds, stages assets, builds the manifest, stages the artifact, inspects it, archives it, generates and verifies a SHA-256, then uploads.
- `publish` — downloads every architecture artifact, re-verifies each checksum, then creates the release. Depends on `artifact`.
- `docker` — unchanged GHCR behavior, now depends on `artifact`.

Top-level permissions were reduced from `contents: write` + `packages: write` to
`contents: read`; write scopes are declared only on the jobs that need them.

The old untested `dist/xistance-panel-v<version>.tar.gz` and the separate static
archive are gone. Exactly the inspected bytes are archived (`-C dist/artifact .`),
checksummed, and uploaded under architecture-scoped paths with
`if-no-files-found: error`.

## Contract defects found and fixed

The first workflow draft invoked interfaces that did not exist. Each was caught by
reading the real scripts, not by the passing YAML test:

- `stage-release-artifact.ts` accepts only `<repo-root> <destination>`; the draft invented four `XT_RELEASE_*` env inputs. Removed.
- `inspect-release-artifact.ts` uses `--architecture`, not `--arch`. Corrected.
- Nothing created the tarball. Added an explicit archive step from the inspected directory, and the test now asserts every `tar -c` uses `-C dist/artifact .`.
- Staging requires a pre-existing `release-manifest.json` at the repo root, which CI never produced. Added a `release-manifest.ts build` subcommand that generates it from real values, and the workflow now builds the manifest before staging.
- The draft's release notes read a `version.txt` no step writes. Replaced with the `version` job output.

## Architectural problem found: manifest cannot contain the archive digest

The manifest lives *inside* the artifact, so `artifact.sha256` cannot be the digest
of an archive that contains it. Resolved with the standard split:

- the in-artifact manifest records `artifact.sha256` as a deterministic **payload tree digest** (`treeDigest`): SHA-256 over sorted `<file-sha256>  <relative-path>\n` lines, forward-slash normalized;
- the **archive** digest lives in the sidecar `<archive>.tar.gz.sha256`.

`treeDigest` is covered by tests for order independence, content change, restore, and
file addition.

## Runtime version accuracy

`build` reads `next` from the app manifest dependency and `prisma` from the installed
engine, with an explicit override argument. Verified output:
`PRISMA_OK=6.19.3 NEXT_OK=16.3.0`. An earlier draft recorded the app version
(`1.1.2`) as the Next version and `unknown` for Prisma; both were wrong and are fixed.

## End-to-end local execution of the CI command sequence

Run locally against the real build, using the same commands the workflow runs:

- `Wrote release manifest: release-manifest.json`
- `Release artifact inspection: PASS`, `Architecture: amd64`, `Checked files: 1957`
- `Checksum verification: PASS`
- Archive top level contains `./apps/web/.next/...`; `tar -xzOf` confirms `release-manifest.json` ships inside the archive.

## Regression and quality gates

- `scripts/test-release-workflow.ts` — exit 0
- `scripts/test-release-manifest.ts` — exit 0
- `scripts/test-release-artifact.ts` — exit 0
- `scripts/test-release-assets.ts` — exit 0
- Release-script TypeScript check (nine scripts) — `SCRIPTS_TSC=0`
- `npm run lint` — exit 0, no warnings (removed an unused test helper; the pages-directory line is pre-existing)
- `npm run typecheck` — exit 0
- `TURBO_DISABLE=true npx tsx scripts/test-optimizations.ts` — `Results: 77 passed, 0 failed of 77`
- `git diff --check` — exit 0; only the pre-existing LF/CRLF warning for the release workflow

## Open blocker discovered by this task: Prisma is not packaged for Linux

The staged artifact ships **no usable Prisma client**. Verified by inspecting
`apps/web/.next/standalone/packages/db/generated/client/`, which contains only:

- `query_engine-windows.dll.node` (a Windows engine)
- `schema.prisma`

It is missing `index.js`, `package.json`, and every Linux engine
(`libquery_engine-debian-openssl-3.0.x.so.node`). The working tree has these files, so
this is a Next standalone tracing gap, not an absent generate step. An artifact built
this way cannot start on Ubuntu 22.04/24.04, which breaks the zero-build requirement.

This is a genuine defect in the release artifact, not a test failure. It is tracked for
a dedicated packaging task and must be fixed before any VPS acceptance. `TASK-8` is
recorded as passed for the CI wiring it owns; the Prisma runtime packaging remains
open and is called out here so it is not lost.

Also noted: the manifest's Prisma version is currently supplied from
`node_modules/prisma/package.json`, i.e. it records the requirement, not proof that the
engine shipped.

## Scope and privacy notes

No workflow was executed on GitHub and nothing was published, tagged, or pushed. No real
secret values, environment contents, database contents, keys, or tokens were written to
evidence. No reset, clean, or commit was performed, and existing unrelated worktree
changes were preserved.
