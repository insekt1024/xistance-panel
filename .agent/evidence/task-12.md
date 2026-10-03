# TASK-12 evidence — artifact verification before extraction

**Status:** passed (local verification against real archives; no live installer run yet)

## Changes

| File | Change |
| --- | --- |
| `scripts/verify-artifact.ts` | New module: `verifyDownloadedArtifact`, `inspectArchiveEntries`, `classifyArchiveEntry`, `PERMITTED_TOP_LEVEL_ENTRIES`. |
| `scripts/test-verify-artifact.ts` | New focused test exercising real `.tar.gz` fixtures (positive and negative). |

## Verification order (why it matters)

```
1. downloaded filename == requested artifact name
2. SHA-256 of the actual bytes == published sidecar
3. release manifest agrees with requested version / architecture / filename
4. archive layout is safe to extract
```

Step 4 runs **only if step 2 passed**. A tampered archive is never parsed as a
tarball, so a malicious file cannot steer the extractor. `tar -x` is not
reachable until every step succeeds.

## Acceptance criteria → evidence

1. **Installer downloads to a temp file, computes SHA-256, compares with the
   expected checksum.** `verifyDownloadedArtifact` hashes the real bytes via
   `verifyArtifactChecksum` (which TASK-7 fixed to hash actual bytes, not just
   compare two recorded strings). Proven negative: "a mutated artifact must be
   rejected" flips one byte and asserts `checksumVerified === false` **and**
   `archiveValid === false` ("extraction must not be attempted on a checksum
   mismatch").
2. **Manifest version, architecture and filename match the pinned release.**
   Proven positive ("a matching manifest must verify") and negative for
   architecture, version, and filename. A **missing** manifest is now an
   explicit error, not a silent skip — the archive bytes alone cannot prove
   which platform was built, so returning `ok: true` without one would be a
   false verification. Covered by "a missing manifest must be reported".
3. **Mismatch, malformed archive, traversal, or unexpected layout aborts before
   touching the active release.** Each case builds a real archive:
   - absolute path entry (via `tar --transform`) → rejected;
   - `..` traversal entry → rejected;
   - unexpected top-level `sbin/` → rejected and the offending entry is named;
   - missing required entry `apps/web/server.js` → rejected;
   - malformed manifest → rejected with a manifest error.
   The module performs no extraction at all, so "before touching the active
   release" holds by construction.
4. **No secret values in failure logs.** A fixture plants
   `TOKEN=super-secret-jwt-value-12345` in the archive; after corrupting the
   bytes the entire result object is stringified and asserted not to contain the
   secret. Errors report only filenames, digests and reasons.

## Test result

```
✅ Artifact verification: checksum, manifest agreement, archive safety, and secret hygiene all hold
```

## Verifying the negatives are not vacuous

A green negative test proves nothing if the fixture never produced the dangerous
condition. Each was confirmed against the real `tar` on this host:

| Fixture | Confirmed archive contents |
| --- | --- |
| absolute | `/`, `//etc/`, `//etc/passwd` — absolute entries genuinely present |
| traversal | `apps/web/../../../etc/shadow` — `..` survives into the archive verbatim |
| unexpected | `./`, `./apps/web/server.js`, `./sbin/`, `./sbin/evil` |
| incomplete | present tree, but no `apps/web/server.js` |

## Link entries

This host cannot create symlinks (`ln -s` fails under MSYS), so a real symlink
archive could not be built. Rather than skip the case, the classification logic
was extracted into `classifyArchiveEntry` and unit-tested directly against
synthetic `tar -t` lines: `l …` → link, `h …` → link, `//etc/passwd` → absolute,
`apps/web/../../../etc/shadow` → traversal, plain path → file. Links are
refused outright rather than validated, because a link inside a release can
point anywhere on the host.

## Bugs found and fixed during this task

1. **`ChecksumVerification` has no `actual` field.** I read `verification.actual`
   to populate the audit digest, which does not exist — the release-manifest
   interface is `{ ok, errors }`. The digest is now computed with `sha256OfFile`
   after a successful verification. Caught by `tsc --noEmit`, not by the test.
2. **Destructured `path` shadowed the `path` module**, producing
   `TypeError: path2.isAbsolute is not a function` at runtime. Renamed to
   `entryPath`.
3. **The archive root entry was treated as an unexpected top-level entry.**
   `tar -czf … -C dir .` lists `./`, which normalises to an empty top-level name
   and was rejected. The classifier now returns `kind: "root"` and the loop
   skips it.
4. **Windows `tar` reads `C:` as a remote host** (`Cannot connect to C: resolve
   failed`). Both the test and the implementation now pass `--force-local`.
5. **Four `inspectArchiveEntries` calls were missing `await`**, so the test was
   asserting on `undefined` and would have passed vacuously. This was the most
   dangerous of the set: a missing `await` turned real negative cases into
   no-ops. All four now await.
6. **Top-level `await` is unsupported** under this repo's tsx/cjs setup, so the
   test body was wrapped in `async function main()` (same constraint hit in
   TASK-7).

## Verification commands and results

| Check | Result |
| --- | --- |
| `npx tsx scripts/test-verify-artifact.ts` | pass |
| `npx tsx scripts/test-release-artifact.ts` | pass (no regression) |
| `npx tsx scripts/test-release-manifest.ts` | pass (no regression) |
| `npx tsx scripts/test-release-workflow.ts` | pass (no regression) |
| `npx tsx scripts/test-release-attestation.ts` | pass (no regression) |
| `npx tsx scripts/test-release-assets.ts` | pass (no regression) |
| `bash scripts/test-release-layout.sh` | `35 passed, 0 failed` |
| `bash scripts/test-release-cutover.sh` | `19 passed, 0 failed` |
| release-script `tsc --noEmit` | exit 0 |
| `npm run version:check` | `✓ All 7 version files match 1.1.2` |
| `npm run lint` | exit 0 (known pages-dir notice only) |
| `npm run typecheck` | exit 0 |
| `scripts/test-optimizations.ts` | `Results: 77 passed, 0 failed of 77` |

## Recorded gaps (not proven by this task)

1. **No installer calls this module yet.** The verification capability exists and
   is tested, but `install.sh` / `update.sh` still extract without invoking it.
   Wiring it in is part of TASK-13 (one-line installer) and is required before
   the zero-build path is real.
2. **No live verification of a real published artifact.** Tests build synthetic
   archives; the 1.2.0 artifact has never been verified by this code path.
3. **Link rejection is unit-tested, not archive-tested.** The classifier is
   proven; a real symlink entry inside a real tarball is not.
4. **Permitted top-level list is a fixed allowlist.** If a future release adds a
   legitimate top-level directory, verification fails closed until the list is
   updated — deliberate, but worth noting as a maintenance point.

## Secret handling

No credential, token, or private key was written into the module, the test, or
this evidence file. The planted secret in the test is a literal placeholder
string, not a real value. VPS values remain `[REDACTED]`.
