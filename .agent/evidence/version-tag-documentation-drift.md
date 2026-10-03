# The documented install command 404'd — docs pinned a tag that does not exist

## What the defect was

`README.md` and `README_FA.md` hard-coded `v1.2.0` in **15 install commands**
(`--version v1.2.0`, `raw.githubusercontent.com/…/v1.2.0/…`,
`xistance-panel-v1.2.0-amd64.tar.gz`). The code said `1.1.2`. No tag `v1.2.0`
had ever been pushed.

Verified against GitHub, not inferred:

```
GET .../insekt1024/xistance-panel/v1.2.0/scripts/release-install.sh  -> HTTP 404
GET .../repos/insekt1024/xistance-panel/releases/latest                -> HTTP 404
```

So a reader who followed the README verbatim got a 404 on the first `curl`. The
release documentation's primary call to action did not work, and I had been
carrying it as "version cutover pending — a sequencing decision" rather than as
the live, user-facing break it was. The sequencing reasoning was sound but the
conclusion was wrong: the docs were not describing a future release, they were
describing a ref that does not exist.

## Why every existing gate passed

Two checks, both reasonable, neither sufficient:

- `test-release-docs.ts` asserted `--version v\d+\.\d+\.\d+` — the **shape** of a
  tag. `v1.2.0` has the right shape.
- `version:check` compares the seven `package.json` manifests and `version.ts`
  to **each other**. They all agreed on 1.1.2.

Neither ever compared the documentation to the code. `test-readme-fa-parity.ts`
compared the two READMEs to **each other** — both said 1.2.0, so they agreed.
Three suites, three real checks, and not one of them crossed the
documentation-to-code boundary. A tag can be internally consistent across every
file that mentions it and still be fictional.

## The fix

Version cut over to **1.2.0** across the seven manifests, `version.ts`, and the
lockfile root (`npm install --package-lock-only`, which reported `up to date` —
no dependency changes), so the tree is now genuinely the release the docs
describe.

## The assertion that closes it

`scripts/test-release-docs.ts`, new section 1b:

1. `package.json` version must equal `version.ts`'s `APP_VERSION` — the code's
   two own version sources must agree with each other *and* with the docs.
2. Every tag the docs tell a reader to install must equal the tree's version,
   collected from **both** languages and from all three places a tag is
   consumed: `--version <tag>`, the `xistance-panel/<tag>/` raw ref, and the
   `xistance-panel-<tag>-` archive name.

Scoped to those three sites on purpose. Not every `v1.2.0` in a README is a
claim about this release, and a check that fires on prose would be a check
someone deletes.

### It failed before it was satisfied

```
- README.md tells readers to install v1.2.0, but this tree is 1.1.2;
  the raw.githubusercontent fetch for the v1.2.0 ref would 404
- README_FA.md tells readers to install v1.2.0, but this tree is 1.1.2; …
```

The first version of that message interpolated the *code's* tag instead of the
documented one and printed the self-contradictory "tells readers to install
v1.1.2, but this tree is 1.1.2" — a failure that would waste a reader's time
exactly when they need the message. Fixed before the check was ever satisfied.

### Non-vacuity — three mutants

| mutant | killed by |
|---|---|
| tree bumped to 1.2.0, docs left at 1.2.0 (the real fix) | passes — this is the target state |
| `README_FA.md` reverted to `v1.1.2`, code at 1.2.0 | `README_FA.md tells readers to install v1.1.2, but this tree is 1.2.0` **and** the existing bilingual parity check, independently |
| `version.ts` drifted to `1.9.9` | `package.json says 1.2.0 but version.ts says 1.9.9` |

The Persian mutant is worth noting: the **pre-existing** parity check caught it
too. Once the code moves, the bilingual comparison stops being a tautology and
becomes load-bearing — which is the state it should always have been in.

## The check then caught my own leftover

Mutant 3 was left applied. The next full gate reported:

```
version-check  exit=1   ✗ apps/web/src/lib/version.ts: 1.9.9 (expected 1.2.0)
docs           exit=1   - package.json says 1.2.0 but version.ts says 1.9.9
```

Two independent checks, both red, naming the exact drift. That is the first
time in this release that a check caught a mistake of mine rather than
confirming one — which is the point of writing them.

## A second, subtler half of the same defect: the stale release manifest

Cutting the version to 1.2.0 immediately exposed a related trap in
`stage-release-artifact.ts`. It does **not** generate a manifest — it *copies*
`<repo>/release-manifest.json` into the payload:

```ts
const manifestSource = path.join(repoRoot, RELEASE_LAYOUT.manifest);
await copyRequiredFile(manifestSource, path.join(temporary, RELEASE_LAYOUT.manifest), "release manifest");
```

That is correct in CI, where the release workflow writes the manifest three lines
above the staging step. Locally it is a trap: `release-manifest.json` is
**untracked build output**, so a copy left over from an earlier run is picked up
silently. After the cutover the staged payload still declared
`version: 1.1.2` / `releaseTag: v1.1.2` / `xistance-panel-1.1.2-amd64.tar.gz`
while the code was 1.2.0 — and the staging step exited 0. Nothing about the
copy is wrong; the *input* was stale.

Regenerated with the real CLI signature (read from the workflow, not invented):

```
npx tsx scripts/release-manifest.ts build release-manifest.json \
  1.2.0 <40-char sha> amd64 xistance-panel-v1.2.0-amd64.tar.gz \
  apps/web/.next/standalone 6.19.3
```

### A superseded green result worth naming

An earlier full run in this same session reported **12/12 suites, 597
assertions, PASS, artifact covered** — against a staged manifest that still said
`x1.1.2` / `xistance-panel-1.1.2-amd64.tar.gz`. The gate was measuring a payload
from before the cutover and was perfectly happy to say so. It is preserved here
as a cautionary result rather than deleted: a green verdict is only as current as
the artifact it ran against, and the artifact was 33 minutes old.

Two verdicts therefore exist for this cutover, and only the later one counts:

| verdict dir | staged manifest | status |
|---|---|---|
| `gate-munibkau` | `1.1.2` | **superseded** — pre-regeneration |
| `gate-munimvr3` | `1.2.0` | current — 12/12, 597/597, artifact covered |

The tell was not the verdict, it was the mtime: the staged manifest carried
`01:50:51` while the freshly written root manifest carried `06:23:48`. A run that
reports success in 2.4 seconds has not copied a standalone server; it is a
no-op, and the payload underneath is whatever was already there.

Now guarded by `test-release-docs.ts` section 1c: when the manifest exists, its
`version`, `releaseTag`, and artifact name must all carry the tree's version. A
**missing** manifest is explicitly not a failure — CI creates it as part of
staging, and a tree that has never staged has nothing to be stale about.
Mutant: restoring the 1.1.2 manifest → 3 failures naming all three fields.

### One tooling trap, for the record

`npx tsx scripts/version.mjs --show`, `node -p "…"`, and inline
`npx tsx -e "…"` all return **`stdin is not a tty`** and produce *empty output*
in this environment. That reads as "the command produced nothing", not as a
failure — so a shell variable silently ends up empty and a downstream tool
reports the *variable* as invalid ("Release manifest version must be a semantic
version"), sending you to debug the wrong thing twice. Write a small script
file and run it with `node <file>` instead; that works reliably.

## Verification

14/14 local checks exit 0: version-check, typecheck, lint (**0 errors**, 24
warnings), release docs, Persian parity 62/62, installer 41/41, supply-chain
55/55, line-endings, SSH 37/37, SSRF 116/116, XUI, optimizations, method-matrix,
auth-security, `npm audit --audit-level=high` (0 vulnerabilities).

Build, staging, and the 12-suite browser gate re-run after the cutover — the
version string is rendered in the UI, so `smoke-routes` and `artifact-assets`
exercise the new value.

## What this does not change

**The tree is labelled 1.2.0; nothing is released.** No commit, no tag, no
push, and the `v1.2.0` ref still does not exist upstream. The docs are now
*consistent with the code*, which is the fix; they will only become *true* when
the tag is actually pushed. That step is deliberately not taken, and
[the release decision](task-72-final-gate-decision-v2.md) remains NO-GO on
TASK-62–65.
