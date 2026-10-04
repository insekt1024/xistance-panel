# Documented security waiver — GHSA-vfj7-8cjw-p6xm

**Status:** accepted, machine-checked, and under automatic re-evaluation
**Raised:** during the 1.2.0 release gate
**Gate:** `.github/workflows/ci.yml` → step "Dependency audit (high+ blocks; one documented waiver)"
**Enforcement:** `scripts/audit-gate.sh`, proven able to fail by `scripts/test-audit-gate.ts`

## The advisory

| field | value |
|---|---|
| ID | **GHSA-vfj7-8cjw-p6xm** |
| package | `braces` `<=3.0.3` |
| class | CWE-674, uncontrolled recursion (stack exhaustion) |
| CVSS | 7.5 (high) |
| reachability | `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces` |

## Why it cannot be fixed

Every available remedy was tried and measured, not assumed:

1. **There is no patched release.** `braces@3.0.3` is the newest version published.
   `fixAvailable: None`.
2. **A newer parent does not help.** `eslint-config-next@16.3.8` was installed into a
   scratch directory and audited: still vulnerable.
3. **npm's only offered fix is a backwards major.** It proposes
   `eslint-config-next@14.2.35` (`isSemVerMajor: true`) — moving a Next 16 project
   backwards to a 14.x lint config, which would break lint coverage on the current
   framework.
4. **`overrides` cannot route around it.** `micromatch@4.0.8` hard-depends on
   `braces ^3.0.3`, and 3.0.3 *is* the ceiling. There is no other version to point at.

The advisory is therefore **unfixable, not merely unfixed**. It will clear itself only
when upstream publishes a `braces` 4.x or backports a 3.0.4.

## Why accepting it is safe

Each point below is enforced by the gate, not merely asserted here:

1. **Development-only.** `braces`, `micromatch` and `fast-glob` are **absent from both
   shipped artifacts** (amd64 and arm64). The advisory cannot reach a released payload.
2. **Not reachable from our code.** No `braces`/`micromatch` reference exists anywhere in
   the application's source or lint configuration. The sole consumer is the lint
   toolchain.
3. **The shipped tree is clean and stays audited.** `npm audit --omit=dev` reports
   **0 vulnerabilities** across every severity. The gate runs this check first and fails
   the build on any high or critical finding in shipped code.
4. **The waiver cannot silently widen.** `scripts/audit-gate.sh` pins the exact GHSA set.
   Any *new* advisory — in any package, at any severity high or above — fails
   immediately. Only this one advisory is recognised.
5. **Critical is never waivable.** A `critical` advisory fails the gate even if it carries
   this exact GHSA. The waiver is a concession about one `high`, dev-only, unfixable
   finding; it is not a general escape hatch.
6. **Deliberately not `--omit=dev` alone.** Narrowing the audit to production dependencies
   would make the gate green in one edit, but it would drop dev advisories with no record
   of which had been accepted. The `js-yaml` advisory this gate caught was dev-only, so
   dev coverage is retained deliberately.

## How it is re-evaluated

- Every push runs the gate, so a new advisory fails the build on the spot.
- When `braces` publishes a fixed version the advisory disappears from the report, the
  gate reports `AUDIT PASS: no vulnerabilities at all`, and this waiver should be deleted
  rather than left to linger.
- `scripts/test-audit-gate.ts` (part of the aggregate suite) asserts all four verdicts,
  including that an unrelated new high advisory and a critical advisory both fail.

## Alternatives considered and rejected

| option | why not |
|---|---|
| Downgrade to `eslint-config-next@14.2.35` | semver-major **backwards** move on Next 16; breaks lint coverage |
| `overrides` to a `braces` git ref | no fixed commit exists upstream; 3.0.3 is the ceiling |
| `--omit=dev` and drop dev auditing | unrecords what was accepted; loses the `js-yaml`-class coverage |
| leave CI permanently red | gate failure would be normalised and stop meaning anything |

## Sign-off

This is the "documented waiver" the 1.2.0 PRD requires as its sole release-blocking
exception. It is scoped to exactly one advisory, verified dev-only and absent from the
release payload, and it expires automatically once upstream patches.
