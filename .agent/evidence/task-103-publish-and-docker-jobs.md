# TASK-103 — the `publish` and `docker` jobs: one verified, one arch-limited

## The `publish` job's checksum gate is verified

Replayed verbatim against the real archives, with `dist/` populated the way
`actions/download-artifact` with `merge-multiple: true` populates it — both
architectures side by side:

```
verifying xistance-panel-v1.2.0-amd64.tar.gz ... PASS
verifying xistance-panel-v1.2.0-arm64.tar.gz ... PASS
publish checksum step: exit 0
```

## A defect I nearly reported that was not one

The first replay failed:

```
Checksum file has no entry for *xistance-panel-v1.2.0-amd64.tar.gz
```

The sidecar's second field is `*filename` — the GNU binary-mode marker that
`sha256sum` emits. The workflow reads the filename with `awk '{print $2}'`, which
keeps the `*`, and builds `dist/*xistance-panel-v1.2.0-amd64.tar.gz`. On its face
that is a publish-blocking bug in the workflow.

**It is not.** The workflow generates sidecars with the project's own tool:

```yaml
npx tsx scripts/release-manifest.ts sha256 "$archive" > "$archive.sha256"
```

and `renderChecksumFile` emits **two spaces** and no marker:

```
a4453d15…  xistance-panel-v1.2.0-amd64.tar.gz
```

My local sidecars had been produced with `sha256sum`, which adds the `*`. The
workflow never sees a `*`. Regenerating both sidecars the way CI does fixed the
replay, and the repository's sidecars are now byte-identical in format to what
CI will ship.

Worth recording because the failure looked exactly like a release-blocking
workflow bug, and the temptation was to "fix" correct workflow code. The
`renderChecksumFile` comment already warns about the neighbouring trap
(`console.log` adding a second newline) — the two-space form is deliberate, and
`sha256sum`'s marker is the *other* format, not the canonical one.

## The `docker` job builds one architecture and tags it `latest`

```yaml
docker:
  runs-on: ubuntu-latest          # x64
  steps:
    - uses: docker/build-push-action@…
      with:
        push: true
        tags: ${{ steps.meta.outputs.tags }}   # semver + latest
```

`docker/build-push-action` with no `platforms:` builds for the runner's
architecture only. So the image pushed for release `v1.2.0` is **amd64-only**,
while the release publishes an amd64 *and* an arm64 archive, and the tag
`latest` then points at an amd64-only image indefinitely.

Consequences:

1. An arm64 host pulling `ghcr.io/…:latest` or `:1.2.0` gets no matching image.
2. The image is not multi-arch, so the container and the release artifacts
   disagree about what `v1.2.0` contains.
3. Nothing in the workflow asserts the image is multi-arch, so the job goes green
   while publishing something narrower than the release.

The minimal fix is one line — declare the platforms the release actually ships:

```yaml
      with:
        platforms: linux/amd64,linux/arm64
```

That makes the job build a manifest list covering both architectures, which is
what `type=semver` + `latest` implies. It is a behaviour change (the build takes
longer and needs QEMU for the arm64 leg), so it is recorded here as a finding
rather than changed unilaterally: whether to publish a multi-arch image at all
is a product decision about distribution channels, and a half-measure — building
only amd64 while shipping a tag that claims the whole release — is the one option
that is clearly wrong either way.

Note the contrast with the `artifact` job, which was fixed for exactly this class
of defect (TASK-101 / earlier): there, `runner_arch` was declared in the matrix
and never referenced, so the arm64 cell silently ran on x64. Here the job has no
matrix at all and no `platforms`, so it is single-arch by construction. The
workflow's own comment on the artifact job says the architecture must be the
runner's *real* architecture — which is exactly why the image cannot be made
multi-arch from an x64 runner without an explicit `platforms:` list.

## What is established

- The `publish` job's checksum gate: **verified** against the real archives.
- The `docker` job: **single-architecture by construction**, verified by reading
  the action inputs and the runner.
- The release notes, attestation and `action-gh-release` steps require network and
  credentials and cannot be exercised here.
