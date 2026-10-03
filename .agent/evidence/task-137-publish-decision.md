# TASK-137 — the publish decision, and why no release was cut

**Date:** 2026-10-03. **Decision:** commit + push to master. **No tag, no GitHub
release.** Authorized by the maintainer after thirty turns of asking.

## What was published

`8e366d8..35044fc` — 11 commits, in the order `.agent/evidence/task-113-commit-plan.md`
sets out. `origin/master` verified equal to local `HEAD` after the push.

Verified on the committed tree before pushing, not only before it:

| gate | result |
| --- | --- |
| `git status --porcelain -uall` | **0** — tree fully committed |
| `npm run version:check` | PASS — all 7 version files match 1.2.0 |
| `npm run typecheck` | 0 errors |
| `npm run lint` | 0 errors |
| `run-all-tests.ts` | **76/76 suites, RESULT: PASS**, exit 0 |
| leak check on every staged path | 0 `.data/`, 0 `node_modules/`, 0 `dist/`, 0 `*.pem`/`*.key` |
| `apps/web/.env.local.example` | placeholders only; every secret is `TODO_FILL_MANUALLY` |

## The readiness finding this closes

`scripts/release-install.sh`, `scripts/lib/release-layout.sh` and
`scripts/lib/service-unit.sh` were **UNTRACKED** for the whole session. A tag
could not have carried them, so the documented one-line install 404'd and the
installer's own fixes could not ship. All three are tracked now.

## Two omissions found in the plan's own path lists

The plan was written 2026-10-02 and its `scripts/` and `packages/` lists were
built from what existed then. Re-deriving the inventory from `git add -An`
(517 paths) surfaced two gaps that would each have shipped broken code:

1. **`packages/types/` was missing from commit 5.** The plan listed
   `packages/tunnel-core`, `packages/db`, `packages/i18n` — not `types`, which
   holds **every** `Zod` schema. Without it the repository would carry builders
   against schemas it does not contain.
2. **`tunnels/examples/` was missing from commit 6** — the nine canonical
   per-method configs, including the `xray-vless.json` that TASK-130 corrected.

A third group appeared during execution: 20 more `scripts/` files (install,
update, backup, bootstrap, and the artifact-digest helpers) that no listed commit
covered. They landed as a twelfth commit, `feat(ops)`.

## Why the PRD is NOT complete, and no release was cut

`.agent/prd/PRD.md` §5, line 42, in the maintainer's own words:

> **`arm64` is therefore a required target.** Building and testing the arm64
> artifact remains a separate, **unmet release gate**.

The workflow agrees: `publish` does `needs: [version, artifact]`, and `artifact`
is a matrix over amd64 + arm64, so **a GitHub release cannot exist without the
arm64 cell passing**. arm64 has never been built, installed, or run in CI here —
no binfmt-QEMU on this host, and no native arm64 runner.

So publishing a `v1.2.0` release would have required either marking the PRD
complete when it is not, or making arm64 non-blocking — which changes the release
contract so that amd64 ships without the arm64 evidence the PRD requires. Neither
is a decision to make silently, and the maintainer chose the option that ships
nothing incorrect.

## What amd64 has, for the record

| claim | evidence |
| --- | --- |
| archive built, checksummed | 40,752,327 bytes, `sha256sum: OK` |
| installed by the real installer | Ubuntu 22.04 and 24.04, health 200 |
| all nine methods carry real traffic + SIGKILL reconnect | 19/19 traffic suite; `real-binary-evidence.json` |
| six fixes live in the running release | 7–8 chunks each, verified in the deployed bundle |

amd64 is genuinely production-ready. It is one architecture of two.

## To finish the release

1. Tag `v1.2.0` on `35044fc` (or later).
2. Dispatch the release workflow — its arm64 cell runs on a native
   `ubuntu-24.04-arm` runner and now installs the artifact before uploading.
3. Confirm both matrix cells pass; `publish` then creates the release.

Steps 1–3 need either a native arm64 runner or a maintainer-initiated CI run.
Nothing else is outstanding on the amd64 side.
