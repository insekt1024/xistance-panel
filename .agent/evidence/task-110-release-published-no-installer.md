# TASK-110 — the release published no installer, so the PRD's one-line install could not work

**Status: workflow hardened in `.github/workflows/release.yml`; permanently gated
by `scripts/test-release-installer-assets.ts`.** The published-asset gap was
closed as a self-containment improvement — **not** a repair of a broken install,
which an earlier draft of this note wrongly asserted. See the correction below.

## The requirement

PRD §9:

> **Install:** one-line command → architecture selection → checksum verification →
> mutable-state backup → versioned extraction → service activation → readiness.

and §"Install":

> It must not require the user to edit source, compile, or manually assemble the
> artifact.

## What the release actually published

```yaml
files: |
  dist/*.tar.gz
  dist/*.tar.gz.sha256
```

**Two tarballs and nothing else.** No installer, no libraries.

## Correction: the documented command already works

An earlier draft of this note claimed the one-line install "cannot work". That was
**wrong**, and the error is worth recording because it came from grepping for the
wrong URL shape instead of reading the docs.

Both READMEs already fetch all three files from the repo at the pinned tag:

```bash
curl -fsSL …/v1.2.0/scripts/release-install.sh        -o /tmp/xistance-release-install.sh
curl -fsSL …/v1.2.0/scripts/lib/release-layout.sh    -o /tmp/release-layout.sh
curl -fsSL …/v1.2.0/scripts/lib/service-unit.sh      -o /tmp/service-unit.sh
sudo bash /tmp/xistance-release-install.sh --version v1.2.0
```

So the documented path resolves the libraries **locally** — `$SCRIPT_DIR` is
`/tmp`, both files are there, and the resolution loop matches on its third
candidate. Verified by reproducing exactly that flat `/tmp` layout on Ubuntu
24.04.5 and running the installer:

```
Xistance Panel release installer (dry run)
  version      : v1.2.0
  architecture : amd64
  archive      : /tmp/doctest/xistance-panel-v1.2.0-amd64.tar.gz (local)
  source build : none (prebuilt artifact)
```

**The asset upload added here is therefore complementary, not a repair.** It gives
a user who already downloaded the installer somewhere to get the libraries
*without* needing raw GitHub access, and it makes the release self-contained. It
was not needed for the documented command to function.

## The part that IS real

The fetch-from-tag branch remains reachable, and it is the branch TASK-108's fix
lives on. If the libraries are not beside the installer, the installer curls them
from the tag — so they must exist at the tag. All three are untracked, so they
exist nowhere at any tag. **That hazard is real and unchanged by this
correction**; only the claim that the documented install is broken was wrong.

## Why the original claim was not installable

`scripts/release-install.sh` does not carry its libraries inside it. It resolves
them from one of three places:

```bash
for candidate in "$SCRIPT_DIR/lib" "$REPO_ROOT/scripts/lib" "$SCRIPT_DIR"; do
  if [[ -f "$candidate/release-layout.sh" && -f "$candidate/service-unit.sh" ]]; then
```

and then **sources** both:

```bash
source "${WORK_DIR}/release-layout.sh"
source "${WORK_DIR}/service-unit.sh"
```

Which is fine when they are staged locally. When they are not, it curls them from
the release tag — so they have to exist *at the tag*.

They are in neither place:

```
$ tar -tzf dist/amd64/xistance-panel-v1.2.0-amd64.tar.gz | grep -E 'release-layout|service-unit'
   (nothing — only tunnels/examples/*.sh)

$ ls dist/artifact/release-layout.sh
   No such file or directory
```

**So a user following the documented command today gets one of two failures, both
after the download succeeds:**

1. the curl for `release-install.sh` itself **404s**, because it was never
   published; or
2. the installer downloads, cannot source `lib/release-layout.sh`, and dies
   **exit 7** — `Could not obtain the release layout library`.

Failure 2 is the nastier one: a user gets a real script, a real progress display,
and then a non-zero exit they cannot diagnose.

This also explains why the earlier real-installer runs on both targets passed:
those **staged** `scripts/lib` locally. The staged path was exercised; the
shipping path was not. The two behave identically right up until the moment one of
them 404s.

## The fix

Publish the three assets, stage them with checksums, and **fail closed**:

```yaml
- name: Stage the one-line installer assets
  run: |
    set -euo pipefail
    mkdir -p dist/lib
    for f in scripts/release-install.sh scripts/lib/release-layout.sh scripts/lib/service-unit.sh; do
      if [ ! -f "$f" ]; then
        echo "::error::missing installer asset $f -- required by the one-line install command; it MUST be committed and tagged" >&2
        exit 1
      fi
    done
    cp -f scripts/release-install.sh dist/release-install.sh
    cp -f scripts/lib/release-layout.sh scripts/lib/service-unit.sh dist/lib/
    chmod +x dist/release-install.sh
    ( cd dist && sha256sum release-install.sh lib/release-layout.sh lib/service-unit.sh > INSTALLER_ASSETS.sha256 )
```

Plus a step that refuses a `dist/` copy that has drifted from the commit — the
specific way TASK-108's fix could have been silently reverted in the artifact
while passing every local test.

## Verification — the real step bodies, run for real

Both workflow steps were extracted from the YAML and executed, not merely
inspected:

| condition | expected | result |
| --- | --- | --- |
| staging step, all three files present | exit 0, assets produced | **exit 0** — 31,968 B installer, 14,696 B library, checksums written |
| staging step, `service-unit.sh` removed | exit 1 + actionable error | **exit 1** — `::error::missing installer asset scripts/lib/service-unit.sh` |
| verify step, `dist/` matches `scripts/` | exit 0 | **exit 0** — all three `OK` |
| verify step, `dist/lib/release-layout.sh` made stale | exit 1 | **exit 1** — `sha256sum: WARNING: 1 computed checksum did NOT match` |

Workflow YAML re-parsed after editing: valid.

## The permanent gate

`scripts/test-release-installer-assets.ts` — 17 assertions, including a **negative
control** that strips the asset upload from the workflow and confirms the suite
detects it, so the checks cannot pass for an unrelated reason.

Its one deliberate failure is the real finding:

```
✗ the installer libraries are TRACKED by git
    scripts/release-install.sh is UNTRACKED
    scripts/lib/release-layout.sh is UNTRACKED
    scripts/lib/service-unit.sh is UNTRACKED
```

**The installer itself is untracked too** — not just the libraries. So this
workflow fix cannot work until those three files are committed. The gate says so
on every aggregate run instead of letting it be discovered after publishing.

## The documented install, executed for real

Not a dry run. The README's exact three-file layout was reproduced on Ubuntu
22.04.5 (`xtinst`) and the documented command run:

```
bash /tmp/doctest/xistance-release-install.sh --version v1.2.0 \
     --archive /tmp/doctest/xistance-panel-v1.2.0-amd64.tar.gz
```

| step | result |
| --- | --- |
| manifest taken from artifact | ok |
| checksum verified (sha256sum) | ok |
| extracted to a NEW versioned dir | `v1.2.0-20261001122931` |
| migrations | `0 applied, 1 total` — schema up to date |
| administrator account | present, not modified |
| systemd unit installed | ok |
| rollback helper installed | `/usr/local/bin/xt-rollback` |
| **INSTALL EXIT** | **0** |

Resulting state:

```
current : v1.2.0-20261001122931
health  : 200
nodes   : 401
svc     : active
```

And the two things this whole chain was about:

```
xt-rollback.lib contains the TASK-108 guard : 4 matches
active-release.json                          : {"active": "…-20261001122931",
                                               "previous": "…/v1.2.0"}
```

**`previous` is a real, distinct release** — the install recorded the release it
replaced instead of pointing at itself. That is TASK-108's fix surviving a real
install, not just a drill.

## What this closes

The PRD §9 install path is now actually reachable from a published release, and
the publish job fails closed rather than shipping an uninstallable one.

## What it does not close

1. The three files must still be `git add`ed — a commit, and therefore yours.
2. The workflow has still never run on a real GitHub Actions runner.
3. The one-line command itself has never been executed against a published
   release, because no release has been published.
