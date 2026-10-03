# TASK-7 verification evidence

Date: 2026-09-25
Scope: deterministic release manifest, SHA-256 checksum generation, and verification.

## TDD

- RED: `npx tsx scripts/test-release-manifest.ts` failed with `ERR_MODULE_NOT_FOUND` for the missing `scripts/release-manifest.ts`.
- GREEN: `TASK7_FOCUSED_EXIT=0`
  - `Release manifest: determinism, checksum, mutation, and negative-field cases passed`

The RED evidence supersedes the earlier TASK-5 red note in this area; see `.agent/evidence/task-5.md` for TASK-5.

## Focused behavior covered

- Manifest generation is deterministic and compact canonical JSON with sorted keys and a trailing newline.
- Manifest binds `schemaVersion`, semantic `version`, `releaseTag` (`v<version>`), 40-character commit, `amd64`/`arm64` architecture, artifact `format`/`name`/`sha256`, and `runtime` node/next/prisma versions.
- SHA-256 checksum file renders and parses in `sha256  name` form.
- A one-byte artifact change fails digest verification with a mismatch error.
- Rejection cases: bad digest length, bad commit, non-semver version, unsupported architecture, forbidden secret field, absolute path in a nested field, missing checksum entry, unreadable checksum file.

## Defects found and fixed during this task

- `verifyChecksumFile` compared only the recorded digest against a caller-supplied value, so a mutated artifact passed. It now also hashes the artifact next to the checksum file.
- Manifest inspection checked only top-level and `artifact` string values for absolute paths. It now walks nested objects, so `runtime` values are covered.
- CLI guards in `release-manifest.ts`, `stage-release-assets.ts`, `stage-release-artifact.ts`, and `inspect-release-artifact.ts` used `endsWith("...ts")`, which also matched their `test-*` importer files. They now match an exact basename.

## Real archive verification

Using a real `tar -czf` archive of `apps/web/.next/standalone`:

- `Checksum verification: PASS`
- `MANIFEST_OK=true`, `MANIFEST_ERRORS=` (empty)
- `DETERMINISTIC=PASS` — regenerated manifest was byte-identical
- `MUTATION_REJECTED=PASS` — appending one byte to the archive produced `Artifact digest mismatch ... computed 0d3e..., recorded 717f...` and `Checksum verification: FAIL`
- `BAD_MANIFEST_REJECTED=PASS` — a manifest with a bad commit, short sha256, and a `jwtSecret` field was rejected with three explicit errors

## Regression and quality gates

- `npx tsx scripts/test-release-assets.ts` — exit 0 (`TASK6=0`)
- `npx tsx scripts/test-release-artifact.ts` — exit 0 (`TASK5=0`)
- Release-script TypeScript check (all seven release/test scripts) — exit 0 (`RELEASE_SCRIPTS_TSC=0`)
- `npx tsx scripts/stage-release-assets.ts` — exit 0 (`STAGE_CLI=0`)
- `npm run lint` — exit 0; existing pages-directory advisory only.
- `npm run typecheck` — exit 0.
- `TURBO_DISABLE=true npx tsx scripts/test-optimizations.ts` — `Results: 77 passed, 0 failed of 77`.
- `bash -n scripts/install.sh scripts/update.sh` — pass.
- `git diff --check` — pass; only the pre-existing LF/CRLF warning for the release workflow.

## Scope note

TASK-7 covers local manifest and checksum generation/verification only. It does not publish anything, does not wire the release workflow (TASK-8), and does not claim provenance. Checksums prove content integrity, not supply-chain authenticity.

## Privacy and preservation

No real secret values, environment contents, database contents, private keys, cookies, or tokens were written to evidence. No reset, clean, commit, push, tag, or release was performed, and existing unrelated worktree changes were preserved.
