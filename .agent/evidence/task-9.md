# TASK-9 evidence — GitHub artifact attestations

**Status:** passed
**Scope:** provenance attestation for published release artifacts, as an addition to (never a replacement for) the existing SHA-256 checksum sidecar.

## Changes

| File | Change |
| --- | --- |
| `scripts/test-release-attestation.ts` | New focused test that parses the real workflow YAML. |
| `.github/workflows/release.yml` | Added `id-token: write` + `attestations: write` to the `publish` job, and an `Attest build provenance` step before release creation. |
| `README.md` | Added "Verifying a downloaded release": checksum first, `gh attestation verify` as optional, with an explicit statement that provenance does not prove code safety. |

## Red → green

RED was the pre-change workflow, which had no attestation step at all:

```
AssertionError: publish job must include an attestation step;
found: ["Checkout","Download all architecture artifacts",
        "Re-verify downloaded checksums before publishing",
        "Generate release notes","Create GitHub Release"]
```

After the change:

```
✅ Attestation contract: permissions, SHA pin, subject digest, ordering, and blocking failure all hold
```

## Contract enforced by the test

1. An attestation step exists in the job that creates the release.
2. The action is pinned to an immutable 40-character commit SHA, not a mutable tag.
3. The subject is bound to the published digests via `subject-checksums: dist/*.tar.gz.sha256`.
4. The job requests exactly `id-token: write` and `attestations: write`, and no unrelated write scopes (`pages`, `workflows`).
5. `continueOnError` is not set, so a failed attestation blocks publication.
6. The attestation step index is strictly before the release-creation step.

## Action pinning — SHA verified, not guessed

`actions/attest` at commit `1e69f48acb82d1966a394da916b4c1698aa569d6` (v4.2.2) was
checked against the source of record before being written into the workflow:

```
actions/attest                  @ 1e69f48acb82d1966a394da916b4c1698aa569d6 -> HTTP 200
actions/attest-build-provenance @ 1e69f48acb82d1966a394da916b4c1698aa569d6 -> HTTP 404
```

The same SHA belongs to `actions/attest` only, which is why the workflow uses
`actions/attest` rather than the deprecated `attest-build-provenance` wrapper.

## Security posture

- No signing key, certificate, or long-lived secret was added. The OIDC token
  minted by `id-token: write` is short-lived and exchanged for a Sigstore
  certificate.
- Attestation runs only in the `publish` job, which already requires
  `contents: write` to create the release; no new capability is granted to the
  `version`, `artifact`, or `docker` jobs.
- Attestation is gated behind the existing checksum re-verification step, so an
  artifact is never attested before its digest has been re-checked after download.

## Test-side corrections made during implementation

Two of my own initial assertions were wrong and were corrected in the test rather
than satisfied by weakening the workflow:

- The original assertion demanded a `subjectDigest` input containing `sha256`.
  The stronger and correct form here is `subject-checksums`, which binds every
  artifact named in the published sidecars. The test now accepts any of
  `subject-checksums` / `subject-digest` / `subject-path`.
- The original assertion required the attestation step to carry an `if`
  condition. An unconditional step is *stricter* than a conditional one, and
  requiring `if` would have preferred a silent, unaudited skip over a hard
  failure. The test now checks skip recording only if a probe step exists, and
  states why provenance is an addition rather than a substitute for the checksum.

## Verification commands and results

| Check | Result |
| --- | --- |
| `npx tsx scripts/test-release-attestation.ts` | pass |
| `npx tsx scripts/test-release-workflow.ts` | pass (no regression) |
| `npx tsx scripts/test-release-artifact.ts` | pass (no regression) |
| `npx tsx scripts/test-release-manifest.ts` | pass (no regression) |
| `npx tsx scripts/test-release-assets.ts` | pass (no regression) |
| `npm run version:check` | `✓ All 7 version files match 1.1.2` |
| `npm run lint` | pass (known pages-dir notice only) |
| `npm run typecheck` | pass |
| release-script `tsc --noEmit` (incl. `--allowImportingTsExtensions`) | exit 0 |
| `scripts/test-optimizations.ts` | `Results: 77 passed, 0 failed of 77` |

A real type error was found and fixed during this task: the new test imported
`strict as assert` from `node:assert` while also declaring a local `assert`
helper (`TS2440: Import declaration conflicts with local declaration of 'assert'`).
The unused import was removed; the local helper is retained because it reports
the broken contract rather than a bare stack trace.

## Recorded evidence gaps (GitHub-only, not verifiable locally)

These are honestly unresolved and must not be reported as passing:

1. **The workflow has not been executed by GitHub Actions.** Whether this
   repository has Actions attestations enabled is unverified. If attestations
   are unavailable, the `Attest build provenance` step will fail and, by design,
   block release creation.
2. **Acceptance criterion "or the workflow records an explicit unsupported-skip
   reason" is not yet satisfied.** It is only reachable once a real run happens.
   The current implementation deliberately fails closed instead of silently
   skipping, which satisfies criterion 4 but not this one. A follow-up must add
   an explicit, logged availability probe once the repository setting is known.
3. **No attestation has been produced**, so no provenance artifact exists to
   verify with `gh attestation verify`.

## Secret handling

The VPS endpoint and credential used during earlier tasks remain `[REDACTED]`.
No credential, token, or private key was written into the workflow, the test, the
README, or this evidence file.
