# TASK-113 — the commit plan, and two ignore-rule leaks it exposed

**Aggregate 72/72, exit 0 after the `.gitignore` repair. Nothing is committed by
this document** — it is the staging order I would execute on your approval,
prepared so the commit is mechanical rather than improvised.

## The count I had been quoting was wrong

`git status --porcelain` reported **238** dirty paths. That is the short form,
which collapses each untracked **directory** to one line. The real figure:

```
$ git status --porcelain --untracked-files=all | wc -l
475
```

153 evidence files and 85 test suites were each counting as 1. Every size estimate
I had given — in reports to you as recently as the previous turn — was wrong by
roughly half. The short form is fine for "is the tree dirty"; it is not an inventory.

## Two leaks found and closed while preparing this

The plan is only safe because `.gitignore` was wrong in two places. Both would
have shipped in a blanket `git add -A`. Neither was visible in
`git status --porcelain`, and neither would be caught by "is the tree clean?".

### 1. 17 MB of cross-platform Prisma engines

```
packages/db/node_modules/.cache/prisma/master/<sha>/linux-musl-openssl-3.0.x/libquery-engine
packages/db/node_modules/.cache/prisma/master/<sha>/linux-musl-openssl-3.0.x/libquery-engine.gz.sha256
packages/db/node_modules/.cache/prisma/master/<sha>/linux-musl-openssl-3.0.x/libquery-engine.sha256
```

The rule was `/node_modules` — **root-anchored**, so `packages/*/node_modules` was
never covered. These are `linux-musl` engines sitting in a repo whose artifacts are
supposed to contain exactly one correctly-matched engine: the same class of
foreign-native binary that TASK-95 exists to keep out of the payload, just landing
in the repository instead of the artifact.

Fixed: `node_modules/` (no leading slash), so every workspace is covered.
Verified 0 tracked files under `node_modules` were hidden — there were none.

### 2. `.data/` runtime state

`.gitignore` covered `**/*.db`, so the SQLite files were safe, but **`.data/test-out.txt`
was not** — an extension no rule matched. 15 KB of a test suite's stdout.

`/.data/*.db` files there hold **`scrypt` passwordHash values** and live `Session`
rows. They were never at risk (the `*.db` rule held), but the directory had no rule
of its own, which is one careless edit away from exposing them.

Fixed: `.data/` ignored whole.

## Verified safety of `git add -A`

```
472 paths would stage
.data/            0
node_modules/     0
dist/             0
.next/            0
tunnels/bin/      0
*.pem *.key *.p12 0
.env              1  -> apps/web/.env.local.example
```

The single `.env` is the template. Its values are all
`/absolute/path/to/xistance-panel/...` placeholders, and the real
`apps/web/.env.local` is correctly ignored.

## The commits

Ordered so each is independently reviewable, and the security-relevant one is
separated from the bulk.

| # | Conventional Commit | scope | paths |
| --- | --- | --- | --- |
| 1 | `chore(repo): ignore nested node_modules and local .data runtime state` | `.gitignore` | 1 |
| 2 | `feat(prd): add the v1.2.0 product requirements, task ledger and evidence` | `.agent/prd`, `.agent/tasks`, `.agent/evidence` | 228 |
| 3 | `feat(release): add the zero-build installer, updater and rollback tooling` | `scripts/release-install.sh`, `scripts/lib/**`, `scripts/stage-*.ts`, `scripts/release-manifest.ts`, `scripts/verify-artifact.ts`, `scripts/xistance.service.template` | ~20 |
| 4 | `fix(release): fix installer argument parsing, archive output and manifest provenance` | the TASK-91/96/100/105 repairs inside those tools | (folded into 3) |
| 5 | `feat(core): harden tunnel lifecycle, config validation and status semantics` | `packages/**` (all four: tunnel-core, db, i18n, **types**) | 29 |
| 6 | `feat(web): nine tunnel methods, diagnostics and dashboard hardening` | `apps/web/**`, `tunnels/examples/**` | 89 |
| 7 | `test: add the release, installer, security and target-OS suites` | `scripts/test-*` | **89** |
| 8 | `ci: gate the release on provenance, installer assets and the documented install` | `.github/workflows/{ci,release}.yml` | 2 |
| 9 | `build: bump to 1.2.0 and record the release manifest` | `package.json`, `package-lock.json`, `Dockerfile`, `release-manifest.json` | 4 |
| 10 | `docs: document the pinned one-line install in English and Persian` | `README.md`, `README_FA.md`, `AGENTS.md`, `docs/**` | 5 |
| 11 | `chore(agent): local agent loop state` | `.claude/**`, `.agent/*.json` | 4 |

**7 changed files in `scripts/` are not `test-*`** and belong to 3: `reconcile-task-ledger.py`,
`stage-local-test-artifact.ts`, `xistance.service.template`.

### Updated 2026-10-03 — before the 11 commits landed

Counts re-derived from `git add -An` (517 paths), not from the older
`git status --porcelain` short form. Two **omissions in the path lists** were
found, both of which would have left code uncommitted:

- **`packages/types/` was missing from commit 5.** The plan listed
  `packages/tunnel-core`, `packages/db`, `packages/i18n` — but not `types`, which
  holds every `Zod` schema. Leaving it out would have shipped builders against
  schemas that are not in the repository. Commit 5 is now `packages/**`.
- **`tunnels/examples/` was missing from commit 6.** It holds the nine canonical
  per-method example configs, including the `xray-vless.json` whose
  `followRedirect` and REDIRECT documentation TASK-130 corrected.

With those added, the eleven commits cover **517 / 517** paths — no residual.

The CI order gates all pass at this point: `version:check` (7 files match 1.2.0),
`typecheck` 0 errors, `lint` 0 errors.

### Updated 2026-10-02 — counts only

Two things changed since this plan was written, neither of which alters its
structure or ordering:

- **`scripts/test-*` is 86 files, not 85.** `test-dashboard-legibility.ts` was
  added by TASK-114. Commit 7's path list is `scripts/test-*`, so it picks it up
  without amendment — but the stated count was wrong.
- **Commit 8's `release.yml` grew by 352 lines.** TASK-119 added the arm64
  install gate (TASK-120 then fixed three defects in it), and TASK-121 corrected
  `release-version-commit-parity.ts`. The ordering constraint below still holds:
  **9 must still come after 8.**

The four open gates this plan does *not* close are unchanged, plus one: the arm64
artifact is stale and must be regenerated by CI on a native arm64 runner
(TASK-118), and it has never been installed by any process (TASK-119).

## What each commit is for

- **1 first, alone.** If the ignore rules are wrong, every later commit inherits the
  leak. Reviewable on its own, and it is the only commit that can be reverted
  without consequence.
- **2** is the paper trail — 228 files of PRD, ledger and evidence. Largest by count,
  lowest by risk.
- **3–4** carry the release tooling and its repairs (archive self-inclusion,
  `--prisma-client` argument indexing, two-pass manifest provenance, partial-extraction
  safety). These are what make 8 meaningful.
- **5–6** are the product itself.
- **7** proves 5–6. 85 suites, aggregate-owned.
- **8** fails closed when 3's assets are missing.
- **9** is the version bump that 8's parity gate is currently reporting as a
  **readiness finding**.

## Ordering constraint that is not cosmetic

**9 must come after 8.** `test-release-version-commit-parity.ts` compares `HEAD`
to the worktree. If 9 lands first, the parity gate sees a committed 1.2.0 and the
release workflow's always-bump behaviour produces `v1.2.1` instead of `v1.2.0`.
Landing 8 first means the gate is present and reporting while the bump happens.

## Why `v1.2.0` cannot come from the workflow

`.github/workflows/release.yml` always bumps a patch:

```
1.1.2 --bump--> v1.1.3
```

Once these 11 commits land, `HEAD` is 1.2.0, so dispatching the workflow would
produce **`v1.2.1`**. Reaching `v1.2.0` requires either:

- a maintainer decision to tag `v1.2.0` directly, outside the workflow; or
- a workflow input that sets the version absolutely rather than bumping it.

Both are yours. I have not chosen.

## Three readiness findings this plan resolves

| finding | resolved by |
| --- | --- |
| the 7 version files are uncommitted (1.1.2 vs 1.2.0) | commit 9 |
| `release-install.sh` + both `scripts/lib/*.sh` are UNTRACKED, so the documented install 404s and TASK-108's fix does not ship | commits 3 and 9 |
| no `v1.2.0` tag | your tag decision |

## Still not resolved by this plan

1. **Native arm64 installation.** Requires the tag, then a run on
   `ubuntu-24.04-arm`. QEMU cannot substitute — its `tar` fails on a 192-byte
   archive (TASK-112).
2. **Live GitHub Actions execution**, including the arm64 matrix leg.
3. **Approval-gated:** distinct-host `REVERSE` (`GatewayPorts clientspecified`),
   live password-reset execution, the `/opt/xistance` diagnostic.

## If you want it staged but not committed

I can `git add` the three installer files only. That clears two readiness findings
and makes the shipping path provably intact, with no commit and no tag. Say the
word and I will.
