# Supply-chain audit — Xistance Panel

**Task:** TASK-45 · **Date:** 2026-09-27 · **Scope:** dependencies, CI actions, tunnel
binaries, artifact integrity, release permissions.

> This audit deliberately downloaded and executed nothing beyond resolving
> action tags to commit SHAs. Fetching a binary to audit whether it is safe
> would be the vulnerability.

**Release decision: one blocker found and fixed (`next` critical RCE). One
accepted, documented risk remains (tunnel binary checksums are not yet pinned —
see §4).** Nothing here asserts a binary is safe.

---

## 1. Dependency audit

Command: `npm audit --omit=dev --audit-level=high`

### Before

```
6 vulnerabilities (5 high, 1 critical)
```

| Package | Severity | Advisory | Direct | Range | CVSS |
|---|---|---|---|---|---|
| **next** | **critical** | [GHSA-p293-qw3h-jr36](https://github.com/advisories/GHSA-p293-qw3h-jr36) — unauthenticated RCE on Windows-hosted servers | yes | ≥16.0.0 <16.3.3 | **9.0** |
| **next** | **critical** | [GHSA-2xp9-vwfh-vxw4](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4) — unauthenticated RCE in the Image Optimization API with AVIF | yes | ≥16.0.0 <16.3.3 | — |
| sharp | high | [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) — libheif | no | <0.35.4 | — |
| nanoid | high | [GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8) — infinite loop when `size` is 0 | no | <3.3.18 | 5.9 |
| deepmerge-ts | high | [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) — stack exhaustion merging recursive graphs | no | <8.0.0 | — |
| prisma | high | transitive via `@prisma/config` | yes | 6.13.0-dev.1 – 8.1.0-dev.4 | — |

### The critical one

`next@16.3.0` was **unauthenticated remote code execution, CVSS 9.0** — in the
framework this release ships, reachable by anyone who can reach the panel port.
This is not a theoretical finding for a zero-build image that runs as a
long-lived systemd service.

**Fixed.** `next` `16.3.0` → `16.3.6` (fix available, non-major).

Pinned **exactly** (`"16.3.6"`, no caret) so a silent minor bump cannot change
the shipped runtime, and the lockfile was regenerated to match.

### After

```
4 vulnerabilities (4 high, 0 critical)
```

### Disposition of the remaining four

The task says: *do not auto-upgrade dependencies without compatibility tests.*
Each of these is transitive or a patch-level bump inside a major the project
already tests. The owner is the release owner; the decision is **accept for
1.2.0, revisit in the next patch cycle**.

| Package | Reachable in the shipped artifact? | Disposition |
|---|---|---|
| **sharp** (`<0.35.4`) | Transitive of `next`'s image optimizer. libheif decodes **uploaded images**. | **Accept, documented.** The panel exposes no image-upload surface to an unauthenticated caller, which is what makes the libheif path hard to reach. Re-check when `sharp` reaches 0.35.4 via a Next bump. |
| **nanoid** (`<3.3.18`) | Transitive. The advisory is an **infinite loop when `size` is explicitly 0** — not reachable unless a caller passes 0. No such call site exists in this repo. | **Accept, documented.** Upgrading alone would not close the reachable surface, because there is no reachable surface. |
| **deepmerge-ts** (`<8.0.0`) | Transitive of `@prisma/config`, build-time only. Stack exhaustion requires merging a recursive object graph from untrusted input. | **Accept, documented.** Build-time, not in the running artifact. |
| **prisma / @prisma/config** | Build-time CLI. The advisories cover dev-only config handling. | **Accept, documented.** The **runtime** Prisma client/engine path was separately proven on the target host under TASK-73. |

None of these four were suppressed, ignored, or hidden — `npm audit` still
reports them, and `scripts/test-supply-chain.ts` fails if any of them stops
being recorded here.

---

## 2. CI and release actions

### Finding: 14 of 15 action references floated on mutable tags

`actions/checkout@v4`, `softprops/action-gh-release@v2`, and the three Docker
actions all resolved by tag. A tag is a mutable pointer: whoever controls the
upstream repository can repoint `v4` at new code, and a release workflow that
consumes it runs that code **with `contents: write`**.

**Fixed.** All 17 references (both workflows) are pinned to a 40-character
commit SHA, with the human-readable version kept in a trailing comment so a
maintainer can still tell what the SHA is.

| Action | Tag | Pinned SHA |
|---|---|---|
| `actions/checkout` | v4 | `11d5960a326750d5838078e36cf38b85af677262` |
| `actions/setup-node` | v4 | `49933ea5288caeca8642d1e84afbd3f7d6820020` |
| `actions/upload-artifact` | v4 | `ea165f8d65b6e75b540449e92b4886f43607fa02` |
| `actions/download-artifact` | v4 | `d3f86a106a0bac45b974a628896c90dbdf5c8093` |
| `softprops/action-gh-release` | v2 | `3bb12739c298aeb8a4eeaf626c5b8d85266b0e65` |
| `docker/login-action` | v3 | `c94ce9fb468520275223c153574b00df6fe4bcc9` |
| `docker/metadata-action` | v5 | `c299e40c65443455700f0fdfc63efafe5b349051` |
| `docker/build-push-action` | v6 | `10e90e3645eae34f1e60eeb005ba3a3d33f178e8` |
| `actions/attest` | v4.2.2 | `1e69f48acb82d1966a394da916b4c1698aa569d6` (already pinned) |

SHAs resolved via the GitHub API by dereferencing the annotated tag to its
commit. **These will need periodic review** — a pin is only as good as its
maintenance, and a stale pin is its own availability risk. That is a process
commitment, not a code guarantee.

### Permissions

| Workflow/job | Permissions | Verdict |
|---|---|---|
| `ci.yml` (top level) | `contents: read` | Least privilege. |
| `release.yml` top level | `contents: read` | Least privilege default. |
| `release.yml` release job | `contents: write` | Justified — it creates the release. |
| `release.yml` docker job | `contents: read`, `packages: write` | Justified — GHCR push. |

No `write-all`. No secret is interpolated into a `run:` block, where it would be
echoed into the log. `dry-run` is declared **and** tested with
`if: ${{ !inputs.dry-run }}` on both publishing jobs — a dry run that is
declared but never checked would publish anyway.

### Release ordering

The publish job `needs: [version, artifact]`, and the attestation step precedes
`Create GitHub Release`, with a comment stating the failure blocks release
creation on purpose. Correct: an artifact is attested before it can be
published, not after.

---

## 3. Artifact integrity and provenance

Already implemented under TASK-13/16, verified here rather than assumed:

- `release-manifest.ts` computes SHA-256 digests (`createHash("sha256")`) and
  exports `verifyArtifactChecksum`, `verifyArtifactDigest`, `renderChecksumFile`.
- `verify-artifact.ts` is a standalone gate that recomputes the digest and
  refuses to inspect the archive layout when the checksum does not verify.
- `release-install.sh` verifies **before** extraction.
- `actions/attest` uses `subject-checksums: dist/*.tar.gz.sha256`, so provenance
  is bound to the same digests the installer verifies — not to a separately
  computed set that could drift.

### What attestation does and does not prove

`actions/attest` proves **which workflow run and which commit produced these
bytes**. It does **not** prove the build was free of malicious code, that the
source was clean, or that the build host was not compromised. It is a
supply-chain *attribution* record, not a safety guarantee. This file makes no
claim beyond attribution.

---

## 4. Tunnel binary download contract — the accepted risk

### How binaries are obtained

`scripts/install.sh` downloads four binaries from GitHub releases:

| Binary | Source | Version selection | Arch mapping |
|---|---|---|---|
| backhaul | `Musixal/Backhaul` | `$BACKHAUL_VERSION`, else **latest release**, else `v0.7.2` | `backhaul_linux_${GO_ARCH}.tar.gz` |
| frp | `fatedier/frp` | `$FRP_VERSION`, else **latest release**, else `v0.70.1` | `frp_${ver}_linux_${GO_ARCH}.tar.gz` |
| gost | `ginuerzh/gost` | `$GOST_VERSION`, else **latest release**, else `v2.12.0` | `gost_${ver}_linux_${GO_ARCH}.tar.gz` |
| xray | `XTLS/Xray-core` | `$XRAY_VERSION`, else **latest release** (no fallback) | `Xray-linux-64.zip` / `Xray-linux-arm64-v8a.zip` |

`XT_MIRROR` overrides the host; the default is `https://github.com`.

### Finding: every download was trusted on arrival, and versions were not pinned

**Before this task**, `fetch_and_extract` ran `curl -fL` → `tar -xzf` → `chmod +x`
with **no integrity check of any kind**. The version variables defaulted to
**empty**, which meant *resolve whatever GitHub calls "latest"* — so two installs
a week apart could ship different binaries, and a compromise of an upstream
release, a mirror, or the TLS path would be installed silently and then run as a
privileged daemon accepting inbound traffic.

The same held in `BinaryManager`: `sha256` was **optional**, documented as
`"otherwise undefined => trust presence"`.

### Fix: refuse by default, verify before extracting

`fetch_and_extract` now takes a trailing `-- <sha256>` and:

1. computes the digest of the downloaded archive,
2. **verifies before extraction** — an archive that has already been unpacked is
   a window in which unverified content exists on disk,
3. on mismatch, warns with the expected and actual digests and returns non-zero —
   the binary is **not** installed,
4. with no digest supplied, **refuses** unless `XT_ALLOW_UNVERIFIED_BIN=1`, and
   logs loudly when that override is used so an unverified install is never
   mistaken for a verified one.

A per-architecture `declare -A BIN_SHA256` table carries the expected digests.

### Why the digests are empty rather than filled in

The honest reason: **we have not downloaded these binaries and independently
verified them against upstream's published checksums.** Writing a digest we
obtained by fetching the same file we are trying to validate would be circular —
it would record what the mirror served us, not what upstream published. That is
an observation, not a guarantee, and presenting it as a pin would be worse than
an acknowledged gap.

So the contract is: **refuse by default, and say exactly how to supply a digest.**
The failure message prints the URL. An operator who has verified the digest
against upstream's release notes installs with the table filled; an air-gapped
operator who supplies binaries out of band opts in explicitly and the log says
so.

**Release decision: accepted for 1.2.0, owner = release owner.** Filling the
table requires an operator with network access to fetch each binary, compare it
to the upstream project's published checksum, and record the result — work that
has not been done. Until it is, **no tunnel binary is verified**, and no
document may imply otherwise.

### Licences

Not audited. `backhaul` (MIT), `frp` (Apache-2.0), `gost` (MIT) and `xray-core`
(MPL-2.0) are vendored as **user-installed runtime binaries, not redistributed
in the release artifact** — the zero-build image does not ship them. The
one-line installer's `curl | bash` path does fetch them. Licence attribution for
that path is **an open item**, owned by the release owner, and is not resolved by
this audit.

---

## 5. Secret hygiene

- Only the default `GITHUB_TOKEN` is referenced; no long-lived PAT.
- No secret is interpolated into a `run:` block.
- This audit read no `.env.local` and printed no token. `gh` was used only to
  resolve public tag → commit SHAs.
- `scripts/test-secret-redaction.ts` (TASK-44) scans committed evidence for
  token-shaped strings and real PEM blocks; it passes.

---

## 6. Unresolved blockers and owners

| # | Item | Severity | Owner | Decision |
|---|---|---|---|---|
| 1 | Tunnel binary checksums not pinned (§4) | **medium** | release owner | **Accepted for 1.2.0.** Installer now refuses unverified by default, so the exposure requires an explicit operator opt-in. |
| 2 | Binary version defaults to *latest release* | **medium** | release owner | **Accepted for 1.2.0**, mitigated by item 1. Should be pinned per-release once checksums are recorded. |
| 3 | Four high advisories outstanding (§1) | low | release owner | Accepted with reachability analysis recorded per-package. |
| 4 | Licence attribution for installer-fetched binaries | low | release owner | **Open.** Not resolved by this audit. |
| 5 | Pinned action SHAs need periodic review | low | release owner | Open process item. |
| 6 | GitHub Actions / OIDC provenance never executed | — | — | No release exists yet; will be exercised by the first real release. |
| 7 | Docker image build unverified | low | release owner | Docker daemon unavailable in this environment. |

No item above is a reason to block 1.2.0. **Item 1 is the one that would
matter most if it were left silent**, which is why the installer refuses rather
than warns.

---

## 7. Verification

```
scripts/test-supply-chain.ts   49 assertions, static, no network
```

### Mutation testing: 5/5

| Mutant | Change | Result |
|---|---|---|
| M1 | `actions/checkout` unpinned back to `@v4` | **killed** |
| M2 | `next` back to the vulnerable `16.3.0` | **killed** (2 assertions) |
| M3 | the whole verify block moved to AFTER extraction | **killed** |
| M4 | refusal default flipped to trust-on-arrival (`XT_ALLOW_UNVERIFIED_BIN:-1`) | **killed** |
| M5 | `curl -fL` → `curl -L`, so a 404 page would be treated as an archive | **killed** |

### M4 survived the first pass, and that was the important one

The guard originally asserted `XT_ALLOW_UNVERIFIED_BIN` appears *and* that
something compares it against `"1"`. Flipping the **default** from `0` to `1`
leaves that comparison untouched — so the entire fix could be reverted, every
unverified binary trusted on arrival, and the suite stayed green. The guard now
asserts the **default value**, which is the thing actually under test.

This is the same class of error as the M3 survivor in TASK-44: an assertion
about a *mechanism* rather than about the *behaviour*. A comparison existing
says nothing about which side of it you land on.

### Two other test defects worth recording

- An over-anchored regex (`\s*$` on a line that continues) reported
  `XT_ALLOW_UNVERIFIED_BIN defaults to "undefined"` — which reads like a code
  defect, not a test defect, and would have sent me looking in the wrong file.
- M3's first attempt was a **no-op mutant**: the replacement inserted a marker
  before the verify block rather than moving the block, so the run proved
  nothing. Redone by actually relocating the block, and M3 died.

### On the remaining assertions

Enforced as regressions — the suite fails if:

- `next` is declared inside the vulnerable range or moves off an exact pin;
- the lockfile disagrees with `package.json`;
- any advisory disposition stops being recorded here;
- any action reference stops being a 40-char commit SHA;
- a workflow loses its top-level permission default, gains `write-all`, or
  interpolates a secret into a `run:` block;
- the binary checksum stops being verified **before** extraction, or the
  refusal default is removed;
- any of the four binaries stops passing a digest through;
- `curl` loses `-f`;
- artifact verification is removed, reordered after extraction, or the
  attestation stops covering the published sidecars;
- this file starts claiming attestation proves safety, or contains a token.
