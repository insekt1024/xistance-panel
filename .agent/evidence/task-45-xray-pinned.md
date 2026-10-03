# TASK-45 — tunnel binary digest pins: 8/8, and a false upstream claim corrected

## The prior evidence in this task asserted something false

`task-45-tunnel-binary-digests.md` recorded, and `install.sh` carried as a
comment, that:

> XTLS/Xray-core publishes no standalone checksum file, so it legitimately
> cannot be pinned.

**That is wrong.** Xray ships a `<asset>.dgst` next to every release asset. The
GitHub API for the latest release lists 32 `.zip` assets and a `.dgst` for
each — including both Linux ones the installer uses.

The consequence was not just a wrong comment. An empty digest slot makes
`fetch_and_extract` **refuse** the download unless the operator sets
`XT_ALLOW_UNVERIFIED_BIN=1`, so **XRAY tunnels were uninstallable by the
documented default path** — a shipped feature gated behind an override, on the
strength of an assumption nobody checked.

This is the same class as the `169.254.0.0/16` claim in the security review: a
statement about an external system, repeated until it became load-bearing. It
is cheap to check and expensive to inherit.

## The fix

Both slots filled, from upstream's own published digests, each confirmed by a
second independent source:

| slot | source | tag |
|---|---|---|
| `xray_amd64` | `Xray-linux-64.zip.dgst` → `SHA2-256` | `v26.3.27` |
| `xray_arm64` | `Xray-linux-arm64-v8a.zip.dgst` → `SHA2-256` | `v26.3.27` |

```
xray_amd64    upstream .dgst  23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae
              recomputed      23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae  MATCH  (21,136,402 b)
xray_arm64    upstream .dgst  4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c
              recomputed      4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c  MATCH  (19,716,427 b)
```

This keeps the rule the rest of the table already followed: **never fill a
digest slot with a digest obtained by fetching the file you are validating.**
Taken from upstream's `.dgst`, then confirmed by re-downloading — two sources
agreeing.

**Version now travels with the digest.** Xray's block was resolving the tag at
run time via `latest_release`, which would have made the new pin a gate nobody
could pass: the tag floats to the newest release, the digest stays pinned to
`v26.3.27`, and every install refuses. It now uses the same `case` pairing as
frp/gost/backhaul, with the version defaulting to `v26.3.27` when a pin is
present and warning loudly on an override that would be refused.

Result: **8/8 slots pinned**, so a partial binary install now means network or
mirror trouble rather than an un-pinnable upstream.

## The test gap that let a wrong claim ship

`test-supply-chain.ts` asserted that each binary's digest is **wired into the
download** (`BIN_SHA256[xray_${GO_ARCH}]` appears in the call) and that the
table has per-arch **slots** (`[xray_amd64]` exists). Both passed with the
values set to `""`. The suite could see the plumbing and never checked the
water.

Three assertions added:

1. **All 8 slots present** — no binary may silently lose its key.
2. **Every slot holds a 64-char lowercase hex digest** — counted over the whole
   table, not a per-slot `ok()`, so it fails if *any* slot is empty or
   malformed and names which. Written as one grouped condition on purpose: a
   loop that emits a bare `ok()` per slot passes when every slot is empty.
3. **A pinned digest pins the version** — each of the four binaries must default
   to the tag its digest came from. This is the assertion that would have caught
   the floating-version trap before it shipped.

### Non-vacuity — three mutants, each killed by its own assertion

| mutant | result | assertion that fired |
|---|---|---|
| both xray slots emptied (the original defect) | 54/1 | `every digest slot holds a 64-char hex SHA-256` |
| `xray_amd64` truncated to 8 hex chars | 54/1 | `every digest slot holds a 64-char hex SHA-256` |
| Xray version floated back to `latest_release` | 54/1 | `XRAY: a pinned digest pins the version to v26.3.27` |

Clean: **55 passed, 0 failed**. `install.sh` restored byte-identical
(`diff -q`) after each mutant.

## One false alarm worth recording

My first digest comparison reported `MISMATCH` for both architectures. The
recomputed values were byte-identical to upstream. The cause was
`sha256sum … | cut -d" " -f1` on MSYS, where the path argument arrives
backslash-escaped and the leading `\` landed in the captured field. A hashing
tooling artifact, not a supply-chain finding — and exactly the shape of thing
that gets reported as "the upstream digest doesn't match" and sends someone
looking for a compromise that isn't there.

## Verification

| check | result |
|---|---|
| `bash -n scripts/install.sh` | OK |
| CRLF in `install.sh` | 0 (LF only — this is a shipped POSIX script) |
| `scripts/test-release-installer.sh` | 41/41 |
| `scripts/test-supply-chain.ts` | 55/55 (was 49) |
| `scripts/test-line-endings.sh` | exit 0 |
| version-check / typecheck / lint | exit 0 / exit 0 / exit 0 (**0 errors**, 24 warnings) |
| `npm audit --audit-level=high` | exit 0, 0 vulnerabilities |

## What this does not prove

The pins were confirmed against upstream **today**, from this machine, over the
public release URLs. They are immutable per tag, so they do not decay — but this
is not a signature or an attestation. It proves the installer fetches the exact
bytes upstream published, and nothing about whether that upstream is the
upstream anyone intends to run. That gap is inherent to checksum pinning and is
recorded in the skill rather than papered over here.

Still unverified for the same reason as the rest of the release: the install
has not been **executed** on an Ubuntu host. This is a source-level and
digest-level fix. TASK-62 is where it gets proven.
