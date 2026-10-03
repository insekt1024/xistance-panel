# TASK-5 verification evidence

Date: 2026-09-25
Scope: release artifact layout, staging, inspection, and focused regression tests.

## Focused tests

- `npx tsx scripts/test-release-artifact.ts`
  - `TASK5_FOCUSED_EXIT=0`
  - Output: `Release artifact inspection: incomplete, complete, forbidden, mismatch, staging, and CLI cases passed`
- `npx tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions --skipLibCheck --types node scripts/inspect-release-artifact.ts scripts/stage-release-artifact.ts scripts/test-release-artifact.ts scripts/stage-release-assets.ts scripts/test-release-assets.ts`
  - `RELEASE_SCRIPTS_TSC_EXIT=0`

## Full local quality gates

- `npm run lint` — exit 0; only the existing pages-directory advisory was emitted.
- `npm run typecheck` — exit 0.
- `TURBO_DISABLE=true npx tsx scripts/test-optimizations.ts` — `77 passed, 0 failed of 77`.
- `bash -n scripts/install.sh scripts/bootstrap.sh scripts/update.sh scripts/backup.sh scripts/uninstall.sh` — `SHELL_SYNTAX_PASS`.
- `TURBO_DISABLE=true npm run build` — `BUILD_EXIT=0`; standalone server present.
- `npx tsx scripts/stage-release-assets.ts` — exit 0; real standalone paths present and no `static/static` or `public/public` nesting.

## Real artifact staging and inspection

Using the actual `npm run build` output, a temporary manifest without secret values was created, `scripts/stage-release-artifact.ts` staged the output, and `scripts/inspect-release-artifact.ts` inspected it:

- `Release artifact inspection: PASS`
- `Architecture: amd64`
- `Checked files: 1957`
- `REAL_ARTIFACT_STAGE_INSPECT=PASS`

Temporary manifest and candidate directory were removed after the check. No release was published and no target VPS was changed.

## Privacy and preservation

No real secret values, environment-file contents, database contents, private keys, cookies, or tokens were recorded. Existing unrelated worktree changes were not reset, cleaned, committed, or overwritten.
