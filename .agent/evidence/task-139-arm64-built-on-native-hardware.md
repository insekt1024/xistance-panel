# TASK-139 — arm64 is now BUILT, on native aarch64 hardware

The gate that had been open for the whole session — "arm64 has never been built
anywhere" — is now closed with real evidence, not emulation.

## How

`ubuntu-24.04-arm` is a GitHub-hosted runner, free because **this repository is
public**. So the blocker was never hardware; it was that the release workflow's
arm64 cell only runs after a tag, and a tag needs the gate closed first. A
circular dependency, resolved by adding an `arm64` job to `ci.yml` that runs on
every push.

This host could never have done it: no binfmt-QEMU
(`/proc/sys/fs/binfmt_misc` does not exist), `docker buildx --platform
linux/arm64` fails with `exec format error`, and Prisma's query engine is a
**native binary generated on the target architecture**, so nothing can
cross-stage it.

## The evidence

Run `37151742784`, job **"Arm64 payload (native runner)" — 16/16 steps success**:

| step | result |
| --- | --- |
| Report runner architecture (`uname -m` = aarch64) | success |
| Build packages (**native Prisma engine generated on aarch64**) | success |
| Build standalone output | success |
| Seed / build / inspect the arm64 manifest | success |
| Stage the arm64 artifact | success |
| Archive + checksum | success |
| Verify the embedded digest describes the archive | success |
| Confirm the payload carries an arm64 query engine | success |
| Upload the arm64 payload | success |

Downloaded and checked independently on this x64 host:

```
xistance-panel-v1.2.0-arm64.tar.gz   26,713,213 bytes   (artifact: 26,632,038)
sha256sum -c ............: OK
manifest architecture: arm64
shipped engine: libquery_engine-linux-arm64-openssl-3.0.x.so.node
file(1): ELF 64-bit LSB shared object, ARM aarch64, version 1 (SYSV),
         dynamically linked, stripped   (afc28625cfdf… manifest digest)
```

That is a real aarch64 ELF produced by a real aarch64 compiler on real aarch64
hardware. Not QEMU, not a cross-stage, not a renamed x64 binary.

For contrast, the amd64 artifact ships
`libquery_engine-debian-openssl-3.0.x.so.node` — the two are genuinely
different binaries.

## Two defects the arm64 runs exposed, one of them a release blocker

**1. The stager refused arm64 (LATENT RELEASE BLOCKER).**
`stage-release-artifact.ts` requires `release-manifest.json` at the repo root,
copies it into the staged tree, and then *inspects* it. The repository's
committed manifest says `amd64`, so:

```
Release manifest architecture mismatch: expected arm64
```

The amd64 cell passes only **by coincidence** — the committed file happens to
match the architecture being built. The release workflow's arm64 cell would
have failed identically. Fixed in both workflows: seed the manifest for the
architecture being built before staging, then rebuild it against the staged tree
(the step that already follows). The seeded digest is provisional and harmless
because `stagedPayloadDigest` excludes `release-manifest.json` — a file cannot
contain its own hash.

**2. The provenance step read the wrong manifest.** It reads from beside the
archive, but the archive step never copied it there, so it fell back to the
root copy — the provisional seed carrying the pre-staging digest — and compared
a stale digest against the real tree.

Both were found only because the job ran arm64 for real. Neither was visible
from amd64, and the second would have been invisible until an arm64 release.

## What this does NOT close

- **Native arm64 installation.** The job builds, inspects, archives and
  verifies. It does not install. The release workflow's arm64 install gate
  remains the place that happens, after the tag.
- **The `xtinst`/`xt24` containers do not exist in CI.** Two suites still need
  them; see `task-138-first-live-ci-run-found-six-defects.md`.

So the PRD's arm64 requirement moves from *"never built"* to *"built and verified
on native hardware, not yet installed."*
