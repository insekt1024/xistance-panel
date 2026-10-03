# TASK-6 verification evidence

Date: 2026-09-25
Scope: explicit embedding of `public` and `.next/static` in the standalone release tree.

## Focused tests

- `npx tsx scripts/test-release-assets.ts`
  - `TASK6_FOCUSED_EXIT=0`
  - Output: `Release assets: public/static layout and JS/CSS/media HTTP smoke passed`
- `npx tsx scripts/test-release-artifact.ts`
  - `TASK5_REGRESSION_EXIT=0`

The fixture verified JS, CSS, media, and public HTTP responses, replacement of stale destination directories, and absence of `static/static` and `public/public` nesting.

## Real build and staging

- `TURBO_DISABLE=true npm run build` — `TASK6_BUILD_EXIT=0`; standalone server present.
- `npx tsx scripts/stage-release-assets.ts` — `TASK6_STAGE_REAL_EXIT=0`.
- Real paths verified:
  - `apps/web/.next/standalone/apps/web/server.js`
  - `apps/web/.next/standalone/apps/web/public`
  - `apps/web/.next/standalone/apps/web/.next/static/chunks`
- `TASK6_NESTED_STATIC=absent`
- `TASK6_NESTED_PUBLIC=absent`

## Quality gates

- `npm run lint` — exit 0; existing pages-directory advisory only.
- `npm run typecheck` — exit 0.
- `TURBO_DISABLE=true npx tsx scripts/test-optimizations.ts` — `77 passed, 0 failed of 77`.
- Release-script TypeScript check — exit 0.
- `bash -n scripts/install.sh scripts/bootstrap.sh scripts/update.sh scripts/backup.sh scripts/uninstall.sh` — `TASK6_SHELL_SYNTAX=PASS`.
- `git diff --check` — pass; only the existing LF/CRLF warning for the release workflow was emitted.

## Scope and preservation

No database, secret, environment value, private key, cookie, or token was written to evidence. No reset, clean, commit, push, release, or VPS operation was performed. Existing unrelated worktree changes were preserved.
