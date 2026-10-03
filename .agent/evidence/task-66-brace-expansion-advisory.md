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
