# TASK-73 — arm64 release cell could never have succeeded (declared-but-unused matrix key)

Date: 2026-09-30
Status: defect found, fixed, mutation-verified
Scope: `.github/workflows/release.yml` (arm64 cell), `scripts/test-release-workflow.ts`

## Summary

The release workflow declares a two-cell architecture matrix (amd64, arm64) and
gives each cell a `runner_arch` value, but the job's `runs-on` was a static
`ubuntu-latest` that never referenced `runner_arch`. Both cells therefore ran on
x64. The arm64 cell passed `--architecture arm64` to the stager, which selects
the Prisma native query engine for that architecture — but Prisma picks the
engine for the machine that generates the client, so an x64 runner can only
ever stage the x64 engine. The arm64 cell was guaranteed to fail inspection
("Prisma payload has no native query engine for arm64") and could never produce
a real arm64 archive.

The PRD makes arm64 support conditional on a feasibility gate in TASK-1, which
records the architecture-specific runner as *not yet verified*. This defect is
the concrete reason it was unverified: no architecture-specific runner was ever
actually selected.

## The defect

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - architecture: amd64
        runner_arch: x64
      - architecture: arm64
        runner_arch: arm64        # declared...
steps: ...
runs-on: ubuntu-latest            # ...and never referenced
```

`runner_arch` appeared on exactly two lines in the file, both declarations.
There was no `${{ matrix.runner_arch }}` consumer anywhere, so the value was
decorative. The existing matrix assertion in
`scripts/test-release-workflow.ts` only checked that the *strings*
`amd64` and `arm64` appeared in the matrix — it passed against the broken
workflow, so the defect was invisible to the suite.

## The fix

`.github/workflows/release.yml`:

```yaml
runs-on: ${{ matrix.runner_arch == 'arm64' && 'ubuntu-24.04-arm' || 'ubuntu-latest' }}
```

`ubuntu-24.04-arm` is a real GitHub-hosted arm64 label, confirmed against
GitHub's own documentation and `actions/partner-runner-images`:

```
ubuntu-22.04-arm
ubuntu-24.04-arm
ubuntu-26.04-arm
```

The arm64 cell now builds on an actual arm64 machine, so the Prisma client it
generates carries the arm64 engine and staging selects the matching binary.

## The regression test

`scripts/test-release-workflow.ts` now asserts two things the previous suite
did not:

1. **`runner_arch` must actually be consumed.** A declared-but-unreferenced
   matrix key is the exact failure mode; the test rejects it by name.
2. **What `runs-on` YIELDS for `runner_arch=arm64` must be an arm runner.**
   This is evaluated, not pattern-matched.

`resolveRunsOnFor()` implements GitHub's `cond && a || b` ternary semantics and
returns the label the expression selects for a given `runner_arch`. Returning
`null` for any construct it does not understand (a bare `${{ matrix.runner_arch }}`,
an unknown condition) makes the caller reject it rather than accept a string
that merely looks right.

### Why evaluation, not a regex

The first version asserted `/arm/i.test(runsOn)` — that "arm" appears
somewhere in the string. **That mutant survived**, because an expression can
name an arm runner in a branch it never takes:

```yaml
runs-on: ${{ matrix.runner_arch == 'arm64' && 'ubuntu-latest' || 'ubuntu-latest' }}
```

Every cell still lands on x64, but the string contains "arm". Evaluating the
expression for each `runner_arch` kills it.

## Mutation testing

Harness: `C:/Users/Insekt/AppData/Local/hermes/cache/scratch/mut-runner-arch.py`
(external scratch; not in the repository). It mutates the real workflow on
disk, asserts the mutation actually landed, and restores the file byte-for-byte.

```
anchor present in current file: OK
baseline (fixed file): rc=0 -> PASS
mutant A_static_ubuntu_latest: landed_on_disk=True rc=1 -> KILLED
    AssertionError: job artifact declares runner_arch for amd64 but runs-on
    ("ubuntu-latest") never references it, so every cell runs on the same
    machine and amd64 cannot obtain its native engine
mutant B_raw_runner_arch: landed_on_disk=True rc=1 -> KILLED
    AssertionError: job artifact builds arm64 on runner_arch=arm64 but runs-on
    ("${{ matrix.runner_arch }}") resolves to "null" for arm64, which is not an
    arm runner
mutant C_arm_maps_to_x64_label: landed_on_disk=True rc=1 -> KILLED
    AssertionError: job artifact builds arm64 on runner_arch=arm64 but runs-on
    ("${{ matrix.runner_arch == 'arm64' && 'ubuntu-latest' || 'ubuntu-latest' }}")
    resolves to "ubuntu-latest" for arm64, which is not an arm runner
restored: rc=0 -> PASS
file byte-identical to pre-test state: True
RESULT: all 3 mutants killed, baseline passes, file restored exactly
```

## Regression check

- `npx tsx scripts/test-release-workflow.ts` — both suites pass.
- `npm run typecheck` — 0 errors.
- `npm run lint` — 0 errors, 23 warnings (pre-existing count, unchanged).
- `npx tsx scripts/run-all-tests.ts` — **51/51 suites passed in 269.4s**, PASS.

## What this does and does not prove

**Proves:** the arm64 matrix cell is now wired to a real arm64 runner, and the
wiring is enforced by a test that cannot be satisfied by a decorative key.

**Does not prove:** that the arm64 cell *succeeds* end to end. Producing a real
arm64 archive requires executing the workflow on a GitHub arm64 runner, which
cannot be done from this Windows/x64 host. The arm64 archive remains
unbuilt and unverified. TASK-1's feasibility gate is now discharged as
*mechanically correct but CI-executed*, not as *verified*.

## Remaining gates (unchanged by this fix)

- No verified arm64 archive exists. `dist/amd64/xistance-panel-v1.2.0-arm64.tar.gz`
  has never been built.
- The current amd64 archive has not been reinstalled on Ubuntu 24.04.5 since the
  UDP bind and checksum-sidecar repairs.
- Distinct-host REVERSE remains unproven; `GatewayPorts clientspecified` was
  never applied (approval timed out).
- The live password-reset run after the doc-path repair was never executed
  (approval timed out). The defect itself is fixed and test-bound.
- XUI is metadata-only by design and cannot carry tunnel-binary evidence.
- Task JSON step flags remain 60/303 `pass: true`; the remainder is backed by
  executed suites and evidence files, not by invented flags.
- No `v1.2.0` tag, commit, push, or public release exists.
