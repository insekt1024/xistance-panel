# TASK-105 — the manifest CLI hashed with the wrong function

**Status: fixed. The entire release sequence now runs end to end for both
architectures.**

Found by running the workflow's steps in the workflow's order — the first time
that was done after the TASK-101 reordering.

## The symptom

The new `Verify manifest provenance against the archive` step failed on a tree
whose staged and extracted contents were **byte-identical** (0 content
differences across 1,987 files):

```
FAIL the embedded digest describes the tree the ARCHIVE extracts to
     manifest says : b753332afd3bf302a89af0ed…
     archive yields: e731bc60686009413c193f60…
```

Byte-identical content and different digests means the two sides were not
computing the same thing. So the question was not "what changed" but "which
function wrote this value".

## The defect

`scripts/release-manifest.ts`, the `build` CLI path (line 384):

```ts
artifactSha256: await treeDigest(payloadRoot),     // INCLUDES the manifest
```

The verifier recomputes with `stagedPayloadDigest`, which **excludes**
`release-manifest.json` because a file cannot contain its own hash. The CLI was
still calling the old `treeDigest`, so:

1. it hashed a manifest that was about to be **overwritten** with that very
   digest, and
2. it hashed it under a **different function** than any verifier would use.

TASK-96 introduced `stagedPayloadDigest` and repaired the two *local* generators
(`stage-real-artifact.ts`, `stage-arm64-artifact.ts`). The CI-facing CLI is a
third caller of the same logic and was missed — the same "check every caller"
lesson as TASK-101, where the workflow itself had drifted.

Fixed to `await stagedPayloadDigest(payloadRoot)`.

## Why nothing caught it

Every existing test passed, because each one exercised a *different* caller:

- `test-release-manifest.ts` builds fixtures with `buildReleaseManifest` and
  supplies the digest as an input, so it never runs the CLI's digest code.
- `test-embedded-manifest-provenance.ts` recomputes from a staged tree that a
  local generator had already produced, so both sides used the same function.
- The local generators were correct, so the local artifacts verified.

The CLI was the only path that mixed the two functions, and **no test ran the
CLI's `build` subcommand against a tree it then verified**. The only thing that
found it was executing the pipeline in order.

## The sequence, end to end, after the fix

| step | result |
| --- | --- |
| 1 `stage-release-assets` | ok |
| 2 `stage-release-artifact --architecture amd64` | ok |
| 3 `release-manifest.ts build … dist/artifact` | ok |
| 4 `inspect-release-artifact --architecture amd64` | **PASS** |
| 5 create archive | ok |
| 6 generate checksum (the tool, not `sha256sum`) | ok |
| 7 verify checksum | **PASS** |
| 8 verify manifest provenance vs extracted archive | **3 passed, 0 failed** |
| 9 `verify-artifact.ts verify` | **exit 0** |

Both architectures, through the same path:

```
amd64: provenance 3 passed, 0 failed | verifier exit 0
arm64: provenance 3 passed, 0 failed | verifier exit 0
amd64 archive: 40,720,xxx bytes
arm64 archive: 25,785,950 bytes
```

## The lesson

**A fix applied to the callers is not a fix.** `stagedPayloadDigest` was created
and wired into two of three producers; the third — the one CI actually uses —
kept the old behaviour and stayed green because every test drove a *different*
entry point.

The test that would have caught this is the one that runs the pipeline in order
and verifies the output against a fresh extraction, which is what this session's
CI-sequence replay did by hand. That is now `test-embedded-manifest-provenance.ts`
in CI mode, exercised against the real tree rather than a fixture.
