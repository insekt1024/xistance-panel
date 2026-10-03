# TASK-95 — the verifier's artifact-name check was a tautology

**Status: product defect found and fixed. Three mutations now prove the gate can
fail.**

Found while rebuilding the arm64 artifact. The real arm64 archive initially
staged an **amd64 embedded manifest**, and nothing objected — because the
verifier derives the artifact name it compares against from the very file it was
handed.

## The defect

`scripts/verify-artifact.ts`, CLI path:

```ts
const result = await verifyDownloadedArtifact({
  artifactPath: artifact,
  expectedArtifactName: path.basename(artifact),   // <-- the tautology
  ...
});
```

`verifyDownloadedArtifact` genuinely checks the name in two places
(`verify-artifact.ts:206` for the file, `:257` for the manifest). But at the CLI
boundary the "expected" name was computed from the file being verified, so the
check could only ever agree:

- hand it the arm64 archive with a manifest naming `...-amd64.tar.gz`
- expected = `basename(arm64 archive)` = `...-arm64.tar.gz`
- manifest says `...-amd64.tar.gz` → should FAIL

and before the fix it did not, because the installer
(`scripts/release-install.sh:355`) passes no expected name of its own, so nothing
upstream supplied an independent one either.

The consequence is a real release hazard: an arm64 archive carrying an amd64
manifest verifies clean, and the architecture a host installs is then decided by
a field nobody checked.

## The fix

Derive the expected name from the *request* rather than from the file:

```ts
expectedArtifactName:
  options.artifactName ?? `xistance-panel-v${version.replace(/^v/, "")}-${arch}.tar.gz`,
```

`--version` and `--arch` are independent inputs the caller already supplies, so
the name comparison is now a real comparison. An explicit `--artifact-name`
overrides it for callers that publish under a different naming scheme.

Confirmed directly against the mutated manifest:

```
error: manifest artifact name xistance-panel-v1.2.0-amd64.tar.gz
       does not match the requested artifact xistance-panel-v1.2.0-arm64.tar.gz
exit: 1
```

## The gate: `test-real-archive-verify.ts`, now per-architecture

The suite previously hardcoded `dist/amd64`, so **the arm64 archive had no
real-tree verification at all**. `test-release-audit`,
`test-release-manifest-freshness` and the root manifest all read amd64 only.
That is how an arm64 artifact could sit weeks out of date and still be green.

It now loops over `amd64` and `arm64`, each with its own tree, manifest, archive
and sidecar, and asserts:

1. the archive, sidecar and manifest all exist — **an unbuilt architecture is a
   FAILURE, not a skip**, so green cannot hide a missing target
2. the manifest names the archive that exists
3. the manifest declares the architecture the tree was staged under
4. the real verifier accepts it, invoked with `--arch` **pinned to the loop's
   architecture** rather than echoed from the manifest — echoing the manifest
   back would have re-created the same tautology one level up

plus the pre-existing negative control (a tree with a forbidden top-level entry
must be rejected).

## Non-vacuity: 3/3 mutations killed

| mutation | caught by | diagnostic |
| --- | --- | --- |
| arm64 manifest `architecture: "amd64"` | assert 3 + verifier | `manifest says "amd64" but the file is staged under dist/arm64`; `manifest architecture amd64 does not match the requested architecture arm64` |
| arm64 manifest `artifact.name: "...-amd64.tar.gz"` | assert 2 + verifier | `manifest says "...-amd64.tar.gz", the file is "...-arm64.tar.gz"`; `manifest artifact name ... does not match the requested artifact ...` |
| arm64 archive absent | assert 1 | `missing: archive, sidecar` |

Baseline after restore: **7 passed, 0 failed**, with both real archives
verifying against the real verifier.

## A note on the mutation runs themselves

Two intermediate mutation runs appeared to *pass* the mutated manifest. They had
not: the `grep -E 'FAIL|passed,' | head -3` pipeline was reporting `head`'s exit
status and truncating before the failure lines, and the earlier `| head` on a
`tar` under QEMU had already produced a misleading SIGPIPE exit code in this same
session. Reading the suite's full output showed `5 passed, 2 failed` with the
right diagnostics. **When a mutation "survives", confirm the mutation landed and
read the full output before concluding anything** — the failure mode is almost
always the reporting pipeline, not the gate.

## The general lesson

A check whose "expected" value is derived from the "actual" value is decoration.
`expectedArtifactName: path.basename(artifact)` looks like a strict name check
and is in fact a no-op. The expected value must come from somewhere independent
— here, the version and architecture the caller asked for.
