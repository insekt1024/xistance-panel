# TASK-119 — CI never installed the arm64 payload it published

**Status: fixed. `.github/workflows/release.yml` now installs and health-checks the
archive on both architectures, before upload. 7 assertions added, 22/22 green.**

## The gap

The artifact job's steps, in order:

```
Build standalone output
Stage public and static assets
Stage release artifact
Build release manifest
Inspect release artifact
Browser gate (staged artifact, amd64)     <- amd64 only
Create archive
Generate checksum
Verify checksum
Verify manifest provenance against the archive
Upload inspected artifact                  <- publishes
```

**There is no install step.** The job builds a payload, checks that the payload is
internally consistent, archives it, and uploads it as a release asset.

So a payload that stages cleanly, passes `inspect-release-artifact.ts`, and carries
a correct manifest could still be **uninstallable on real arm64 hardware**, and CI
would publish it as `xistance-panel-v1.2.0-arm64.tar.gz`.

## Why the local evidence did not cover it

The local amd64 targets prove the installer for amd64. They are amd64 machines.
Nothing anywhere ran the installer against an arm64 payload:

- TASK-112 could not install arm64 even emulated (GNU tar defect, reproduced on a
  192-byte archive);
- the arm64 payload was staged from an image build, never installed;
- and the artifact job — the only automated producer — never installed anything.

**The arm64 payload had never been installed on any machine by any process.** That
is why TASK-118's "arm64 is stale" is not merely a tidiness problem: the stale
artifact is also the only arm64 artifact that has never been proven installable.

## The fix

A step between checksum verification and upload, run on **both** matrix cells:

```yaml
- name: Install the archive on this architecture (fail closed)
  run: |
    set -euo pipefail
    sha256sum -c "$ARCHIVE.sha256"          # identical to what will be published
    bash "$WORK/scripts/release-install.sh" --version ... --archive "$ARCHIVE"
    for _ in $(seq 1 30); do
      code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/health)
      [ "$code" = "200" ] && break; sleep 2
    done
    [ "$code" = "200" ] || { echo "::error::...does not answer /api/health"; exit 1; }
```

Three deliberate choices:

1. **After the checksum verify** — the installer is handed bytes proven identical
   to the uploaded asset, and it re-verifies them itself.
2. **Before the upload** — an uninstallable payload fails the job instead of
   becoming a release asset.
3. **Not gated to amd64**, unlike the browser gate. Gating it would leave arm64
   exactly as unproven as before, which is the entire point.

It also checks `/api/health`, not just the installer's exit code: TASK-113's
install evidence recorded health 200 only because the *server* answered, and
`apply-migrations` is exactly the kind of step that exits 0 while doing nothing
(TASK-115, TASK-117).

## The assertions that keep it

Seven, in `test-release-installer-assets.ts`, covering existence, ordering on both
sides, architecture-agnosticism, the health check, and the checksum re-verification.

One of them caught a real error in my own first draft: I had asserted the install
must follow "Verify manifest provenance", and it did not — provenance is a separate
recomputation that can follow the install, because the installer is already given
the exact bytes being published. The assertion was wrong about the requirement, so
it was corrected to "after the archive exists and its checksum verifies", which is
the property that actually matters.

## What this closes

An arm64 payload is now **provably installable before it is published**, by CI, on
native arm64 hardware — the one place that is possible.

## It has never run -- and it was broken three times before it could

See `task-120-install-gate-assumed-three-preconditions.md`: this step assumed a
staging layout, a variable and a uid that it did not have. Running it caught one
of the three; the other two came only from reading the step and the installer.
It is now 30 assertions, each mutation-proven.

## What it does not close

It has never run. The workflow has still never executed on a real runner
(TASK-102), so this step is unexecuted YAML until the commit and tag exist that
let it run. That is the same blocker as TASK-109/110/111, now with a concrete
artifact it would protect.
