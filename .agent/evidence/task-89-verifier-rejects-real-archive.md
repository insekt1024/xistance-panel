# TASK-89 — the release verifier rejected the real release archive

**Status: closed. A release-blocking defect, found by running the installer's own
verification command against the archive that was actually built. Two separate
defects; the first would have made `v1.2.0` uninstallable.**

## How it surfaced

`release-install.sh` verifies an artifact before extraction:

```sh
npx --yes tsx verify-artifact.ts verify \
  --artifact "$ARCHIVE_PATH" --checksum "$CHECKSUM_PATH" \
  --manifest "$MANIFEST_PATH" --version "$VERSION" --arch "$ARCH"
```

I had never run that exact command against a real archive — only against the
synthetic fixtures in `test-verify-artifact.ts`, which pass. Running it for real:

```
$ npx tsx scripts/verify-artifact.ts verify \
    --artifact dist/amd64/xistance-panel-v1.2.0-amd64.tar.gz \
    --checksum dist/amd64/xistance-panel-v1.2.0-amd64.tar.gz.sha256 \
    --manifest dist/amd64/release-manifest.json --version 1.2.0 --arch amd64

error: archive contains an unexpected top-level entry: apply-migrations.mjs
error: archive contains an unexpected top-level entry: create-admin.mjs
=== VERIFIER EXIT: 1 ===
```

**The artifact this repository builds cannot be installed by its own installer.**
The verifier runs before extraction, so the install would have died at the
verification step on every target OS.

## Defect 1: the allowlist omitted two required files

`PERMITTED_TOP_LEVEL_ENTRIES` in `scripts/verify-artifact.ts` did not list
`apply-migrations.mjs` or `create-admin.mjs`.

These are not incidental. `release-install.sh` hard-fails without them:

```sh
if [[ ! -f "$CANDIDATE_DIR/apply-migrations.mjs" ]]; then
  die "The artifact does not include apply-migrations.mjs; refusing to activate"
fi
...
if [[ ! -f "$CANDIDATE_DIR/create-admin.mjs" ]]; then
  die "The artifact does not include create-admin.mjs; refusing to activate"
fi
```

So the stager is right to ship them and the verifier was wrong to reject them.
The two disagreed, and nothing compared them.

### Why 60/60 suites were green

`test-verify-artifact.ts` builds its fixtures *from the same constant it is
testing*:

```ts
makeArchive(name, [{ path: "apps/web/server.js" }, ...]);
```

and the inspection is called with a `permittedTopLevel` defaulting to
`PERMITTED_TOP_LEVEL_ENTRIES`. **The allowlist is both the assertion and the
fixture, so it cannot disagree with itself.** A whole-file misconfiguration is
invisible to it by construction.

This is the same class as the manifest-staleness finding in TASK-85, one level
up: there, a fixture and a real artifact were both correct but the real artifact
was stale; here, a constant and a real artifact actively contradict each other
and the only test of the constant is built from the constant.

### Fix and proof

Added both entries with the installer's requirement quoted in the comment, then
re-ran the real command:

```
verified: xistance-panel-v1.2.0-amd64.tar.gz (sha256 5affdc7ec7be78104045fd55b10a1b7579b51cdb74f638d034d55ea962f4ea58)
=== VERIFIER EXIT: 0 ===
```

## Defect 2: the embedded manifest describes a tree that is not in the archive

`stage-real-artifact.ts` computes the payload digest over the **build host's**
standalone subtree:

```ts
artifactSha256: await treeDigest(
  path.join(repoRoot, "apps", "web", ".next", "standalone", "apps", "web"),
),
```

then copies that manifest into the staged tree that becomes the archive. But the
archive root contains:

```
apply-migrations.mjs  apps/  create-admin.mjs  node_modules/  packages/
release-manifest.json  tunnels/  xistance.service.template
```

`dist/amd64/apps/web/.next/standalone/apps/web` — the hashed path — **does not
exist in the staged tree.** A consumer who extracts the archive has no way to
recompute the digest it is given.

The two digests are different numbers describing different trees:

```
embedded manifest payload digest : 3a66b5bd0c52f5d4...
root manifest payload digest     : 2ca2e80791d89c7e...
```

### Why it does not fail today

`verifyDownloadedArtifact` compares the manifest's *metadata* (version,
architecture, artifact name) and recomputes the **archive** SHA-256 against the
sidecar. It never recomputes the payload digest, because the payload is still
compressed at that point.

So the field is currently inert — it is recorded, and it is wrong, and no check
reads it. That is a latent defect rather than a live one, and it is the same
latency that let TASK-85's stale manifest survive: a recorded value nothing
verifies.

**This is not fixed.** Fixing it means deciding what the digest should describe
and making the producer and consumer agree:

- if it should describe the archive payload, it must be computed over the
  staged release root (what the installer actually extracts), not the build
  host's standalone subtree; or
- if it is intended as a build-provenance fingerprint, it must be named as such,
  because `artifact.sha256` reads as the artifact's digest and is not.

Either way the producer and the verifier must be checked against each other by a
test that uses a **real staged tree**, not a fixture derived from the same
constant.

## What the finding says about the suite

Two of the three release-blocking defects found in this session
(TASK-87 argv parsing, TASK-89 allowlist) were invisible to a green 60/60 because
the thing under test and the thing asserting it shared a source of truth. A
suite that builds its fixtures from the constant it validates can only ever
prove the constant is internally consistent.

The gate that actually found this one was the most boring possible step:
**running the documented command against the real artifact.** That is now the
release check, and it is not optional.

No credentials, tokens, private keys, or connection details appear in this file.
