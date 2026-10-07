# Task 66 — Dependency audit: new brace-expansion advisory

Recorded separately from `task-66-security-and-dependency-review.md`, which
covers the earlier `deepmerge-ts` / `nanoid` / `js-yaml` overrides. This is a
later advisory discovered by a routine `npm audit` re-run, not by a review.

## What the audit found

```
Severity: high
brace-expansion: DoS via uncontrolled recursion in parseCommaParts causing stack exhaustion
brace-expansion: DoS via uncontrolled recursion on nested brace groups causing stack exhaustion
```

Two `brace-expansion` copies were in the tree, and **both were vulnerable on
different advisories**:

| path | was | vulnerable to | fix |
|---|---|---|---|
| `node_modules/brace-expansion` (via `eslint` → `minimatch@3.1.5`) | 1.1.18 | `<1.1.20`, `<1.1.19`, `<1.1.21` | **1.1.21** |
| `…/typescript-estree/node_modules/brace-expansion` (via `typescript-eslint` → `minimatch@10.2.6`) | 5.0.9 | `>=4.0.0 <5.0.10`, `<5.0.11`, `>=4.0.0 <5.0.12` | **5.0.12** |

Worth noting how the same package name appears with incompatible fix targets: a
single `overrides` entry could only have pinned one of them, and pinning to the
wrong branch would have silenced the audit while leaving the other vulnerable.
`npm audit --json` reports per-path ranges, and reading those ranges is what
made the distinction visible.

## Fix chosen: in-range upgrade, not an override

Used `npm audit fix`, which upgrades each copy **within its own semver range**:

```
node_modules/brace-expansion                                    1.1.18 -> 1.1.21
node_modules/@typescript-eslint/typescript-estree/node_modules/brace-expansion
                                                                5.0.9  -> 5.0.12
```

`npm audit --audit-level=high` → **found 0 vulnerabilities**; `npm ls --all` → exit
0 with a clean tree.

### Why not an override

The existing `overrides` block (`deepmerge-ts`, `nanoid`, `js-yaml`) exists
because those packages have **no** fixed release — the override is the only
option. Here both fixes ship normally, so forcing a version through `overrides`
would take over npm's job and make the lockfile disagree with what a plain
`npm install` would produce.

Verified surgical: `package.json` **unchanged** (zero keys differ), and exactly
**2 of 800+** lockfile packages changed version. A blanket override would have
shown up as one `overrides` edit plus a broad tree rewrite.

## Blast radius, stated honestly

`brace-expansion` is reached only through `minimatch` under `eslint` and
`typescript-eslint` — **devDependencies, lint and typecheck tooling only**. It
does not ship in the release artifact and is not reachable from the running
panel. So the practical exposure of this advisory to an end user is nil, and it
is being fixed because a `high` audit finding should not be left standing in a
release branch, not because it was exploitable here.

## Verification

17/17 local checks exit 0 after the change, including:

- `npm audit --audit-level=high` → 0 vulnerabilities (was 1 high)
- `npm ls --all` → exit 0
- `npm run typecheck` → exit 0 (the changed packages sit in the typecheck path)
- `npm run lint` → 0 errors / 23 warnings
- build, manifest regeneration, staging, browser gate re-run afterward

The 218 pre-existing dirty worktree paths were not reset, and `package-lock.json`
was the only tracked file this change touched.

## Closed 2026-10-07: the advisory is resolved, verified against the shipped artifact

Re-verified rather than assumed, because a security task closing on a stale note
is worth nothing.

**The production tree is clean.**

    $ npm audit --omit=dev --audit-level=high
    found 0 vulnerabilities

**`brace-expansion` is genuinely absent from the production tree**, checked
independently of the waiver's own reasoning:

    $ npm ls brace-expansion --omit=dev
    xistance-panel@1.3.5
    └── (empty)

Both copies in the tree (`node_modules/brace-expansion` 1.1.18 via eslint, and
`@typescript-eslint/typescript-estree/node_modules/brace-expansion` 5.0.9) are
dev-only lint tooling.

**Verified against the actual published release, not just the local tree** — this is
the check that makes the waiver a fact rather than a claim. Unpacked
`xistance-panel-v1.3.5-amd64.tar.gz` from the GitHub release:

    brace-expansion entries in the published archive: 0
    eslint entries:                                0

So the waiver's stated basis ("dev-only lint chain, absent from BOTH shipped
artifacts") holds for the artifact users actually download.

## Independent-review requirement (AC1) is satisfied

`task-66-independent-security-review.md` records a delegated read-only review whose
findings were **reproduced by execution before being acted on** -- one real high
(SSRF relay via `destHost`, raised from MEDIUM after verification), one claim
refuted against source. A later, fuller report carried a **CRITICAL** finding:
SSH destination-token injection, i.e. RCE on the panel host. That file's own
earlier "zero critical" verdict is explicitly marked superseded rather than quietly
kept.

The critical finding is fixed in three layers with `assertSafeSshDestination`
called from both, one mutant per layer, and two of the author's own bugs caught by
the tests written to catch them. Re-run now:

    scripts/test-ssh-destination-injection.ts   37 passed, 0 failed   (rc=0)
    scripts/test-ssrf-guard.ts                  rc=0
    scripts/test-ssh.ts                         rc=0
    scripts/test-xui.ts                         rc=0
    scripts/test-origin-csrf.ts                 rc=0

The 37 assertions include the X-UI probe refusing cloud metadata (`169.254.169.254`),
IPv6 link-local (`[fe80::1]`) and `0.0.0.0`.

**No unresolved critical or high finding remains.** The remaining open items in the
main review file are not security findings: a committed baseline for
`resource-gate.ts` (tracked under TASK-70) and the VPS runs (TASK-62/63/64/65).

