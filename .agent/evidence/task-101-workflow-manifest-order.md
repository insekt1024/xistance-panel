# TASK-101 — the release workflow still had the TASK-96 bug

**Status: two real CI defects found and fixed, with a regression suite.**

I could not run the `ubuntu-24.04-arm` cell. I could run **its steps**, and doing
so found bugs that reading the workflow had not.

## Defect 1: the manifest was built before the artifact was staged

The cell did this:

```yaml
- name: Build release manifest
  run: |
    npx tsx scripts/release-manifest.ts build \
      release-manifest.json ... apps/web/.next/standalone ...
- name: Stage release artifact
  run: npx tsx scripts/stage-release-artifact.ts . dist/artifact --architecture ...
```

That is the TASK-96 defect, still live in CI. The manifest's payload digest was
computed over `apps/web/.next/standalone`, while the archive is built from
`dist/artifact` — which differs by the manifest, the service template, the
migrations, the migration applier and the admin creator. **Every release this
workflow published carried a digest of a tree that never shipped**, and a
downstream verifier recomputing it would reject the artifact.

I had fixed this locally in `stage-real-artifact.ts` and `stage-arm64-artifact.ts`
and never checked that CI used the same sequence. The local fix was invisible to
CI and CI was wrong independently.

**The fix:** stage first, then build the manifest from `dist/artifact`, and
write it *into* the staged tree so the archive carries it. Ordering is now
load-bearing and commented as such.

## Defect 2: nothing verified the manifest against the archive

The cell ran:

```yaml
- name: Verify checksum
  run: npx tsx scripts/release-manifest.ts verify "$archive" "$archive.sha256"
```

That proves the **archive** is intact. It says nothing about whether the manifest
*inside* describes that archive. The workflow had no step comparing them, which
is precisely why Defect 1 could ship.

**The fix:** a new `Verify manifest provenance against the archive` step that
extracts the real archive, recomputes the payload digest, and runs
`verify-artifact.ts`. `test-embedded-manifest-provenance.ts` gained a CLI mode
(`--extract-dir/--manifest/--expect-version/--expect-arch`) so the workflow can
hand it the tree it already extracted.

## Evidence

Replaying the new CI step verbatim against the real amd64 archive:

```
ok   the embedded digest describes the tree the ARCHIVE extracts to
ok   the manifest version matches the release
ok   the manifest architecture matches the cell
--- 3 passed, 0 failed ---   exit 0
```

Real verifier on the same archive: `exit 0`.

Non-vacuity — pointing the arm64 check at the amd64 cell:

```
FAIL the manifest architecture matches the cell
     manifest arm64 vs cell amd64
exit 1
```

## Regression suite

`scripts/test-release-workflow-manifest-order.ts`, 12/12, mutation-verified.
Restoring the original ordering in the workflow file makes **3 assertions
fire**:

```
FAIL the artifact is STAGED before the manifest is built
FAIL the manifest is written into the staged tree
FAIL detecting the reordering is what the assertion does
9 passed, 3 failed
```

and the file restores to 12/12.

It also asserts the arm64 cell runs on `ubuntu-24.04-arm`, that the provenance
step extracts the real archive, and that both matrix architectures are staged.

## What this does and does not establish

**Establishes:** the CI cell's logic is now correct and cannot silently regress
to the ordering bug. The steps it runs have been executed locally against real
artifacts.

**Does not establish:** that the `ubuntu-24.04-arm` cell has *run*. GitHub
Actions has not executed this workflow, and the arm64 runner is still unproven.
A correct workflow that has never executed is a different claim from a verified
one, and only the former is now true.

## Note on how this was found

The local fix existed, the suite covering it existed, and the aggregate was
green — 64/64 — while CI was shipping artifacts with the identical defect. The
gap was that every test ran the *local* scripts and none ran the *workflow*.
Reading the workflow is not the same as running its steps, and this bug was
invisible to a careful read because it looked reasonable: build the manifest,
then stage.
