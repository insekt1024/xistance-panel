# TASK-66 — security and dependency review

## Verdict: dependency criterion MET. Independent review in progress (AC1 pending).

The mechanical work is done and verified. AC1 additionally requires a *fresh
independent* review, which is running in two isolated subagent contexts and is
reported separately. Nothing here is a claim that the whole task is closed.

---

## AC2 — dependency audit and workflow review, with disposition

### Before: 4 high in production

```
npm audit --omit=dev  ->  high: 4, critical: 0
  prisma            (direct)  via @prisma/config
  @prisma/config              via deepmerge-ts
  deepmerge-ts   GHSA-ggr8-5vv4-36mx  CWE-674  stack exhaustion merging recursive object graphs, <8.0.0
  nanoid         GHSA-2v37-7h3g-55p8  CWE-835  non-termination when size=0,  CVSS 5.9, <3.3.18
```

All three non-direct advisories are **build-time** only. `deepmerge-ts` is reached
through `prisma`'s config loader, which runs during `prisma generate`, not in the
served app; `nanoid` is reached through `postcss`, a build-time CSS tool. None
ships in the release payload. That does **not** make them acceptable under AC1,
which requires no unresolved high, so they were fixed rather than waived.

### Fix: `overrides` in the root `package.json`

| package | pinned | advisory | reached via |
|---|---|---|---|
| `deepmerge-ts` | 8.0.2 | GHSA-ggr8-5vv4-36mx | `prisma` → `@prisma/config` |
| `nanoid` | 3.3.19 | GHSA-2v37-7h3g-55p8 | `postcss` (tailwind, next) |
| `js-yaml` | 4.3.2 | GHSA-2883-xcg3-v3hh | `eslint` → `@eslint/eslintrc` (dev) |

`js-yaml` was a 5th advisory visible only in the dev-inclusive audit
(CWE-400/407, unbounded CPU on empty merge sources, `>=4.0.0 <4.3.2`). It is
dev-only, via eslint, and patch-fixed.

**Why overrides and not a prisma upgrade.** The direct `prisma@6.19.3` advisory
is only a proxy: its `via` is `@prisma/config`, whose `via` is `deepmerge-ts`.
Upgrading prisma to clear it would move the major line and force a regenerated
client, for a build-time code path. Overriding the two leaves prisma's major
version, the generated client, and the schema untouched.

**After, verified on the real installed tree:**

```
npm ls deepmerge-ts nanoid js-yaml
  deepmerge-ts@8.0.2 overridden
  nanoid@3.3.19 overridden
  js-yaml@4.3.2 overridden

npm audit --omit=dev  ->  0 vulnerabilities  (exit 0)
npm audit             ->  0 vulnerabilities  (exit 0)
```

### Two ways this went wrong, recorded because both are traps

1. **`overrides` do not appear in `package-lock.json`'s root entry.** npm
   applies them without mirroring the key. I spent a step concluding from
   `overrides: None` that npm had ignored the block. A minimal repro
   (`postcss` + `nanoid` override) showed `nanoid -> 3.3.19` resolving correctly
   *with* `overrides: None` in the lock. The lock's silence is not evidence of
   the override being dropped; `npm ls` reporting `overridden` is.

2. **A stale lock entry blocks an override from taking effect.** After adding
   `overrides`, `npm install` left `deepmerge-ts@7.1.5` in place and `npm ls`
   marked it `invalid`. The fix is a targeted
   `npm install deepmerge-ts@8.0.2 nanoid@3.3.19 --package-lock-only` to
   re-resolve those entries — **but that command adds them to `dependencies` as
   a side effect**, and a direct entry plus an override for the same package is
   `EOVERRIDE`, which then fails every install. The `dependencies` block had to
   be removed by hand. The `//overrides` comment in `package.json` now records
   this so the next person does not re-add them.

   A transient broken state existed in between: after the `EOVERRIDE` failure
   the audit reported `{}` / 0 vulnerabilities, because a failed install leaves
   a tree npm can no longer resolve. **An audit reporting zero on a tree that
   failed to install is not a pass**, and it is recorded here because the number
   looked like success at the time.

### Workflow review (AC2)

`.github/workflows/ci.yml`, `.github/workflows/release.yml`:

- All actions pinned to full commit SHAs with a `# v4` version comment
  (checkout, setup-node, upload-artifact). No floating tags.
- `release.yml` declares `permissions:` at workflow and per-job level; the
  publish job is gated on `if: ${{ !inputs.dry-run }}` and has a dry-run path
  that stops before pushing.
- Browser gate runs against the **staged artifact** before the archive is
  created, i.e. before anything is published.
- `if-no-files-found: error` on the release upload; a checksum is generated
  **and** verified as separate steps.

**One real gap found and fixed.** The audit step was:

```yaml
- name: Dependency audit (high+, non-blocking)
  run: npm audit --omit=dev --audit-level=high
  continue-on-error: true
```

`continue-on-error: true` means no high advisory could ever fail the build,
which directly contradicts AC1. Now that the tree audits clean, the step is
blocking:

```yaml
- name: Dependency audit (high+ blocks)
  run: npm audit --audit-level=high
```

`--omit=dev` was also dropped: dev advisories are worth catching, and the
`js-yaml` one this now covers was dev-only. Verified the new command exits 0
(`found 0 vulnerabilities`).

---

## AC3 — static scans over changed code

Scope: the 37 changed `.ts`/`.tsx`/`.mjs`/`.sh`/`.yml` files (excluding
`node_modules`).

| scan | result |
|---|---|
| hardcoded secrets (`password`/`secret`/`token`/`api_key` = literal) | **none** |
| `eval` / `new Function` | 1 hit, benign — see below |
| shell injection (`${var}` into shell) | no user-controlled interpolation |
| dangerous process execution | 2 real files, both safe — see below |
| path traversal from request data | **none** |

**`new Function` at `scripts/test-a11y-contrast.ts:295`** — compiles four
hardcoded local snippet constants to force a parse error to surface in
milliseconds instead of after the twelve-minute contrast matrix. The input is a
literal in the same file, never request data. Not a finding.

**Process execution.** `packages/tunnel-core/src/runner.ts` and
`apps/web/app/api/nodes/[id]/test/route.ts` invoke remote binaries, which is
the point of the product. Both use array-form `execFile`/`spawn` with `shell`
unset, so no string is ever handed to a shell for parsing. The `.exec(` hits
elsewhere are `RegExp.prototype.exec`, not `child_process.exec`.

**`scripts/install.sh:519`** — `trap "rm -rf '${tmp}'" RETURN`. `$tmp` comes
from `mktemp -d`, not from input. The same function verifies the download
checksum **before** `tar -xzf`, with the reason in a comment: an archive
reaching extraction is already unpacking, so verifying afterwards leaves a
window where unverified content is on disk. That ordering is correct.

**Secret handling spot-check.** `sshFailureMessage()` in the node test route
maps ssh stderr to a fixed reason and returns only a generic
`SSH connection failed (exit N)` for anything unrecognised, specifically so an
admin-only endpoint cannot echo back key fingerprints, identity-file paths, or
a base64 key blob that the local ssh client printed. The detail stays in the
server log.

---

## AC4 — findings ledger

| # | finding | severity | disposition | regression test |
|---|---|---|---|---|
| 1 | `deepmerge-ts` <8.0.0, CWE-674 | high | **fixed** via override 8.0.2 | `npm audit` now 0; `npm ls` shows `overridden` |
| 2 | `nanoid` <3.3.18, CWE-835 | high | **fixed** via override 3.3.19 | same |
| 3 | `js-yaml` <4.3.2, CWE-400/407 | high (dev) | **fixed** via override 4.3.2 | same, dev-inclusive audit |
| 4 | audit step `continue-on-error: true` | high (process) | **fixed**, now blocking | new command verified exit 0 |
| 5 | `package.json#prisma` deprecated, removed in Prisma 7 | low | **waived**, not silently — config-only, Prisma 6 honours it, no runtime effect. Owner: future maintenance. | n/a |
| 6 | `new Function` in a11y contrast harness | info | **waived** — local literal, never input | n/a |
| 7 | `trap rm -rf $tmp` in installer | info | **waived** — `mktemp -d` output | installer suite 39/39 |

## Post-change regression

The dependency change touches the build, so it was re-verified rather than
assumed:

```
version-check 0   lint 0 (24 warnings, 0 errors)   typecheck 0
build:packages 0  (includes prisma generate, which is the deepmerge-ts path)
TURBO_DISABLE=true npm run build  0   (4 warnings, unchanged)
optimizations 0   ssrf-guard 0   xui 0   origin-csrf 0   telemetry 0
resource-budgets 0   bench-sanitized 0   artifact-assets 0   installer 0/39
```

`prisma generate` was confirmed working with the override — it is the exact
path `deepmerge-ts` sits on, so this is the test that matters for finding 1.

## Still open

- AC1's "fresh independent review" — two isolated subagent reviews dispatched;
  their verified findings will be appended here.
- A committed baseline for `resource-gate.ts` so the comparison is meaningful in
  CI (TASK-70 noted this as out of its scope).
- TASK-62/63/64/65: the VPS runs that the release decision depends on.
