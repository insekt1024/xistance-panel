# The CI aggregate step I added would have failed on every runner

Adding `npx tsx scripts/run-all-tests.ts` to the `verify` job in `ci.yml` looked
like a pure win. It was a regression, and it only surfaced by asking a question
I had not asked before: *does this step work on the machine CI runs it on?*

## The defect

`verify` runs on `ubuntu-latest`. Two of the 50 registered suites —
`test-protected-routes.ts` and `test-lowram-cgroup-gate.sh` — exercise the
**staged release payload**, not the source tree:

```ts
// test-protected-routes.ts:234
const artifactRoot = process.env.XT_SMOKE_ARTIFACT ?? path.join(repoRoot, "dist", "artifact");
```
```sh
# test-lowram-cgroup-gate.sh:47
[ -f "$ARTIFACT_ROOT/apply-migrations.mjs" ] || { echo "FAIL: no apply-migrations.mjs in artifact root"; exit 1; }
```

The WSL branch in the runner is gated on `process.platform === "win32"`:

```ts
const useWsl = LINUX_SUITES.has(s.label) && Boolean(distro) && process.platform === "win32";
```

So on a Linux runner both suites take the **local** path and require
`dist/artifact` to exist. The `verify` job had no build step at all — the build
and staging live in the `browser` job, which runs `needs: verify`. The step I
added was therefore guaranteed to fail, on every push and every PR.

## Proof

Artifact temporarily moved aside, the exact CI invocation, run locally:

```
### B. artifact MISSING
exit=1
  FAIL test-protected-routes.ts   1.1s
        | cp: cannot stat '/mnt/e/.../dist/artifact': No such file or directory
  0/1 suites passed in 1.1s
```

The error names `cp` and a `/mnt/e/...` path, because the local machine *does*
have WSL and took the WSL branch. On a Linux runner there is no WSL and no
`/mnt` — it fails the same way, with a less helpful message. The failure is
platform-independent; only the wording differs.

## Two fixes

**1. `ci.yml` — build and stage inside `verify`, before the suite.** A step that
is present but misordered is just as broken as a missing one, so the ordering is
now asserted rather than assumed.

**2. `run-all-tests.ts` — preflight the payload.** Discovering a missing build
30 seconds into a run, from a `cp` error inside a shell script, is a bad way to
learn it. The runner now checks up front and prints the exact commands:

```
FATAL: these suites need the staged release payload, and it is missing:
  - test-protected-routes.ts

  expected: E:\...\xistance-panel\dist\artifact

  build and stage it first:
    TURBO_DISABLE=true npm run build
    npx tsx scripts/stage-release-artifact.ts . dist/artifact --architecture amd64
```

Verified in all three states:

| | expected | result |
|---|---|---|
| artifact present, linux filter | pass | **1/1, exit 0** |
| artifact missing, linux filter | clear fatal | **exit 1, message above** |
| artifact missing, non-linux filter | unaffected | **1/1, exit 0** |

The third row matters: the preflight is keyed on the *selected* suites, so
`run-all-tests.ts ssrf` still works in a bare tree. A guard that blocked
everything would have "fixed" CI by making the suite unrunnable.

## The assertion, and proof it bites

`testCiVerdictRunsAgainstAStagedPayload()` in `scripts/test-release-workflow.ts`
parses `ci.yml` and asserts `build < stage < suite` in the `verify` job, that
both payload suites stay registered, and that the runner keeps its preflight.

| | result |
|---|---|
| fixed `ci.yml` | **exit 0** |
| **MUTANT:** build+stage block deleted from `verify` | **exit 1 — `verify must stage the release artifact before running the suites`** |
| restored | **exit 0** |

Killed by the intended assertion, on a defect that was live minutes earlier.

## Why it was invisible

Everything I ran was correct *locally*. My machine has WSL, a warm
`dist/artifact`, and a staged payload from the last browser gate. The suite
passed 50/50 here and would have failed 0/50 there. A test that only ever runs
on the machine that wrote it verifies the machine, not the change.

**Before wiring a step into a workflow, run the step the way the runner runs it.**
The conditions that make a local pass real — WSL present, artifact staged,
platform match — are exactly the conditions that differ in CI.
