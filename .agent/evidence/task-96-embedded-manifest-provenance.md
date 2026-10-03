# TASK-96 — the embedded manifest described a tree that never shipped

**Status: defect found and fixed on both architectures. Provenance now verifies
against the extracted archive.**

This was the last open release-provenance question. It is now closed.

## The defect

`release-manifest.json`'s `artifact.sha256` is a **payload-tree** digest
(`treeDigest`), not the archive's SHA-256 — that lives in the `.sha256` sidecar.
A verifier recomputing the payload digest before activation is checking that the
manifest describes the tree it is about to extract.

`scripts/stage-real-artifact.ts` computed it as:

```ts
artifactSha256: await treeDigest(path.join(repoRoot, "apps", "web", ".next", "standalone", "apps", "web")),
```

That is a **subdirectory of the build output**. The archive is assembled from
`dist/artifact`, the *staged release root*, which differs by the manifest itself,
the service template, the migrations directory, `apply-migrations.mjs` and
`create-admin.mjs` — 1,968 files versus 1,988.

So the recorded digest described a tree that was never published, and a verifier
recomputing it against the extracted release rejects a perfectly good archive:

```
amd64: manifest says 3a66b5bd…, archive yields 2ca2e807…
arm64: manifest says 387311c9…, archive yields 379a996e…
```

The arm64 case was worse: its manifest had been generated from
`dist/arm64-stage`, the pre-staging tree.

## Two problems, two fixes

**1. Wrong tree.** Added `stagedPayloadDigest(root)` to `release-manifest.ts`:
the same walk as `treeDigest`, but taken over the **staged root** and skipping
`release-manifest.json`.

The skip is required, not cosmetic. A manifest records the digest of the tree it
ships inside; if the digest covered the manifest, writing the digest would change
the bytes being hashed and the value could never be reproduced. Both sides must
skip the same file.

**2. Ordering — the circularity.** The digest covers a tree that must already
contain the manifest, and the manifest contains the digest. The original code got
away with it by hashing a different tree entirely. Fixing (1) exposes the cycle,
so both generators now stage in **two passes**:

1. write a structurally **valid** manifest with a provisional digest (a `{}`
   placeholder fails inspection, which is how this was first discovered)
2. stage → the tree is complete
3. digest that complete tree, skipping the manifest
4. write the real manifest and **re-stage**

Passes 1 and 2 produce the same payload digest, because the manifest is excluded
from the hash. `scripts/stage-arm64-artifact.ts` does this in a `try`/`finally`
that restores the amd64 root manifest, so the repository is never left
describing arm64.

## Verification

`scripts/test-embedded-manifest-provenance.ts` extracts the **real archive** and
recomputes the digest over exactly what a downstream verifier would have:

```
ok   amd64: the embedded digest describes the tree the ARCHIVE extracts to
ok   arm64: the embedded digest describes the tree the ARCHIVE extracts to
ok   a manifest carrying a wrong digest IS reported as a mismatch
--- 3 passed, 0 failed ---
```

Real verifier, both architectures: **exit 0**.

### Non-vacuity: 3/3 mutations killed

| mutation | result |
| --- | --- |
| arm64 embedded digest replaced with 64 zeroes | **killed** |
| arm64 archive rebuilt with `xistance.service.template` removed | **killed** |
| 64-zero digest compared against a real tree digest (control) | **killed** |

The second is the important one: it proves the gate is sensitive to the archive's
*contents*, not merely to the manifest's text.

## Resulting artifacts

| | size | SHA-256 |
| --- | --- | --- |
| amd64 | 40,720,672 | `a4453d159fe26038…` |
| arm64 | 25,785,167 | `0b56ac6a6e3a82fc…` |

Both checksums verify; both payload digests match their extracted trees.

## The general lesson

**A digest is only provenance if it covers the artefact you actually ship.**
Hashing a build subdirectory because it was convenient produces a manifest that
looks authoritative and describes something else entirely. The check that
catches it is cheap: recompute the digest from the *extracted archive* and
compare. Nothing else in the pipeline does that, which is why this survived
across both architectures and a full artifact rebuild.
