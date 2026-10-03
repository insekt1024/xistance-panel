# TASK-68 — Persian README was missing the release-verification procedure

Found while auditing TASK-9's acceptance criteria, not while testing TASK-68.
Worth recording because the parity checker that exists specifically to catch
this class of defect did not catch it.

## The defect

`README.md` documents a three-step release-verification procedure:

1. `sha256sum --check …tar.gz.sha256` — is this the file the publisher made?
2. `npx tsx scripts/verify-artifact.ts …tar.gz` — is it internally sound
   (manifest, archive layout, no absolute paths / `..` / symlinks / secret-looking
   names)?
3. `gh attestation verify … --repo insekt1024/xistance-panel` — was it built by
   this project's release workflow? Followed by the caveat that an attestation
   proves *provenance, not safety*, and is an addition to the checksum, never a
   replacement.

`README_FA.md` documented only step 1. Steps 2 and 3 were absent — a Persian
reader was never told they exist, and never told that an attestation does not
mean the code is safe.

This is exactly the drift TASK-68 exists to prevent, and it shipped anyway.

## Why the parity checker missed it

`test-readme-fa-parity.ts` asserted a `REQUIRED_COMMANDS` entry like this:

```ts
["checksum verification", /sha256sum|release-manifest\.ts verify|verify-artifact/],
```

An alternation asserts *at least one* of three alternatives. `sha256sum` was
present in both documents, so the assertion passed — while `verify-artifact.ts`
was missing from Persian and `gh attestation verify` was missing from *both*
checks entirely (it was not in the list at all).

So the failure was two-layered, and both layers had to be fixed:

1. The alternation could not express "all three steps are documented", only "one
   of them is". Split into three independent entries, each required in both
   documents.
2. Provenance attestation was not an entry at all, so no alternation could have
   caught its absence.

The three are separate actions a reader can take and they answer different
questions, which is precisely why one pattern is the wrong shape for them.

## Verification

The Persian section was written first, then the mutant was applied to prove the
new assertions are the ones doing the work:

| state | result |
|---|---|
| Persian section present | exit 0, 0 failures |
| **MUTANT:** Persian section reverted | exit 1, **2 failures** — `pre-install artifact verification`, `provenance attestation` |
| restored (byte-identical) | exit 0, 0 failures |

Exactly two assertions fired and nothing else, so the guard is bound to the
specific drift rather than to incidental text.

Persian parity now passes 65 assertions (was 62 — the split added 2 checks × 2
documents, minus the one collapsed entry it replaced).

## Note on TASK-9

TASK-9's own criteria are otherwise satisfied and were verified as such:
`release.yml` grants `id-token: write` + `attestations: write`, runs
`actions/attest@v4.2.2` with `subject-checksums: dist/*.tar.gz.sha256` (bound
to the same digests the installer verifies), and places the attest step
immediately **before** `softprops/action-gh-release` — so a failed attestation
blocks publication by ordering, not by an extra conditional.

No signing key or secret was added, per the task's own constraint.
