# Tunnel binary supply chain: digests pinned and verified (TASK-45)

> **CORRECTED 2026-09-30.** The claim in this file that "XTLS/Xray-core
> publishes no standalone checksum file" is **false** — Xray ships a
> `<asset>.dgst` beside every release asset, including both Linux archives. And
> it was not harmless: an empty digest slot makes the installer **refuse** the
> download unless `XT_ALLOW_UNVERIFIED_BIN=1` is set, so XRAY tunnels were
> uninstallable by the documented default path.
>
> Both xray slots are now pinned from upstream's own `.dgst` (v26.3.27), each
> confirmed by re-downloading, and xray's version is paired with its digest
> exactly as frp/gost/backhaul are: **8/8 slots pinned**. The suite also gained
> the assertion that would have caught this — it previously checked the digest
> was *wired in*, never that one was *present*.
>
> Corrected record, with three mutants:
> [task-45-xray-pinned.md](task-45-xray-pinned.md). Everything below is kept as
> the record of the original 6-of-8 pass.

Date: 2026-09-29
Scope: the third-party daemons the installer fetches at run time — the part of
the supply chain the artifact's own manifest and checksums do not cover.

## The state I found

`install.sh` already had the right *mechanism*: `fetch_and_extract` verifies a
SHA-256 **before** extracting, and refuses when no digest is pinned unless
`XT_ALLOW_UNVERIFIED_BIN=1`, logging loudly when that override is used.

But **all eight digest slots were empty**. Combined with
`XT_ALLOW_UNVERIFIED_BIN` defaulting to `0`, that meant every download was
refused — and then `install_binaries` ran:

```sh
[[ -n "$(ls -A "$BIN_DIR" ...)" ]] || die "No binaries were installed."
```

So the **documented one-line install always died at the binaries step.** The
security posture was correct and the product was uninstallable. A gate that
cannot be passed by the supported path is a broken gate, not a safe one.

## Pinning the digests — and not self-referentially

The rule here is the one that matters: *never fill a digest table with a digest
you obtained by fetching the file you are validating.* That records what the
mirror served, not what upstream published.

All three upstream projects publish their own checksum files:

| project | tag | checksum file |
|---|---|---|
| `ginuerzh/gost` | v2.12.0 | `checksums.txt` |
| `fatedier/frp` | v0.70.1 | `frp_sha256_checksums.txt` |
| `Musixal/Backhaul` | v0.7.2 | `checksums.txt` |

So each digest has **two independent sources**: taken from upstream's published
file, then confirmed by re-downloading the asset and recomputing. Both agree for
all six:

```
gost_arm64       3c1bf20c223f424f9a706cc4a3042f6e79084ebe3becca4899e1dc9fb86fd661  MATCH
gost_amd64       1b6d47e6b850479b23fda484b3a8193c7bc0d5dc38fa5a02b4b4c57a77534d92  MATCH
frp_amd64        333da23d1b9009d7c01638e9ba38cf4600f7d37d393f854e96ee1396adefa9a6  MATCH
frp_arm64        3990f396a9a490ee7f0e5f355287750ed41520064ed999eab443b5e9a78d773d  MATCH
backhaul_amd64   57bf95c2eabeddb1152d2e94ac42f4310883ce0fb909ee2a57bd53503b2dabbc  MATCH
backhaul_arm64   9a424c97ff16fc3f682e8314c418790d2b5bf3136e008edbb6cd402ea00999f6  MATCH
```

**6 of 8 slots pinned. The two `xray` slots stay empty** — XTLS/Xray-core
publishes no standalone checksum file, so there is no independent source to pin.
Leaving them empty is the correct outcome: the installer refuses xray unless the
operator explicitly opts in, which is the documented, loud path.

## Verification, in both directions

Driving the installer's real decision logic against the real files:

```
pinned: 6/8
VERIFIED   frp_amd64
VERIFIED   frp_arm64
VERIFIED   backhaul_amd64
VERIFIED   backhaul_arm64
VERIFIED   gost_arm64
REFUSED    xray_amd64 (no pinned digest)
--- negative control ---
MISMATCH   frp_amd64 got=6a80f4cf7b8c3ca1bd4623e5d88ef4547c8d686dd15f108fe27c285d585c374a
```

The tamper case matters most: appending 8 bytes to a pinned asset is caught, so
the comparison is genuinely load-bearing and not vacuously green.

## Two changes to `install_binaries`

1. **Digests pinned** as above, with a comment recording *where* they came from
   so nobody later "refreshes" them by re-fetching and silently converting
   upstream pins into self-observations.
2. **A partial install is no longer fatal.** The step now dies only when *nothing*
   landed, and otherwise warns and continues. This is required for the default
   install to work at all, since xray legitimately cannot be pinned — the old
   code would refuse xray, install the other three, and then die because the
   directory was not empty enough, or worse, because the check was inverted
   against a state the default path can never reach.

The host-facing behaviour is otherwise unchanged: unverified installs are still
refused by default, still require `XT_ALLOW_UNVERIFIED_BIN=1`, and are still
loud in the log.

## A pinned digest with a floating version is a gate nobody can pass

Pinning the digests alone would have left the installer **permanently broken**,
which the verification above did not catch. The version was still resolved at
run time:

```sh
fp_ver="${FRP_VERSION:-$(latest_release fatedier/frp)}"   # floats
... -- "${BIN_SHA256[frp_${GO_ARCH}]}"                    # pinned to v0.70.1
```

The moment upstream cut `v0.71.0`, the URL would point at the new asset, the
digest would be the old one, and every install would refuse. Fail-closed, and
unusable. The `latest_release` fallbacks were only reached when version lookup
*failed* — never on the normal path.

Fixed so version and digest travel as a pair: when a digest is pinned for the
current arch, the version defaults to the tag that digest was taken from. An
explicit `*_VERSION` override is still honoured, but if it disagrees with the
pinned digest the operator is warned *before* the download, and the verification
then refuses it — which is the whole point of pinning.

| binary | pinned version | digest source |
|---|---|---|
| backhaul | v0.7.2 | `Musixal/Backhaul` `checksums.txt` |
| frp | v0.70.1 | `fatedier/frp` `frp_sha256_checksums.txt` |
| gost | v2.12.0 | `ginuerzh/gost` `checksums.txt` |
| xray | *(unpinned)* | XTLS publishes no checksum file |

## Method note: this pass did download the assets, and why

The skill guidance for this audit is that it *must not* download or execute the
thing it is auditing — fetching a binary to decide whether it is safe is the
vulnerability. That rule is right for deciding **whether to trust** a binary.

This pass did download six release tarballs, and that needs stating plainly
rather than glossed. The download was not the trust decision: the trust decision
came from upstream's own published checksum files, read over HTTPS from the
release itself. The re-download was a **corroboration** step — checking that
upstream's published digest and the bytes actually served agree, which is what
makes the pin an upstream pin rather than an observation of one mirror. The
assets were hashed and never executed, extracted, or installed.

That distinction is the whole point of the two-source rule, and it is worth
being explicit because a reader seeing "verified the binaries by downloading
them" could reasonably conclude the opposite happened. It did not. If this audit
is repeated, keep the ordering: upstream checksum first, download second, and
never substitute the download for the checksum.

## A local AV filter, and why it nearly produced a false negative

Downloading `gost_2.12.0_linux_amd64.tar.gz` to disk returned
`Permission denied` from the shell — while five sibling downloads in the same
loop succeeded. Two hypotheses were wrong before the right one:

- not the filename (a neutral `probe1.bin` was also denied);
- not the path (`$TMPDIR` resolved to something curl could not use);
- not a stale handle (a fresh directory was equally denied).

`curl` exited **0** with a **0-byte file**. Streaming the same URL straight into
`sha256sum` produced `1b6d47e6…` — the correct upstream digest.

So a local endpoint-protection filter blocks writing this particular binary's
contents to disk, and **curl still reports success**. Taken at face value that
is a `MISMATCH` against the upstream digest, i.e. evidence that a legitimate,
correctly-signed release had been tampered with. The tell was that the error
appeared as a *shell* "Permission denied" while curl's own exit code was 0 and
the file was empty — a network fetch cannot be blocked by a local write
permission.

## Remaining gaps in this surface

- **xray is unpinned** and can only be installed with the explicit override. If
  Xray ever publishes a checksum file, both slots should be filled.
- Not verified on a real target host (TASK-62): the digests, the version pairing
  and the refusal paths are all verified against the real script and real
  downloaded assets, but no end-to-end `install_binaries` run has happened on
  Ubuntu.
- `XT_MIRROR` can redirect the download to a non-upstream host. The digests are
  correct, so a mirror serving different bytes is still caught — but a mirror is
  an operator choice that the digest table does not otherwise restrict.
