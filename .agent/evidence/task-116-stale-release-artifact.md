# TASK-116 — the verified release artifacts were stale by 16 UI defects

**Status: rebuilt, re-verified, and installed on a real target (INSTALL EXIT: 0).**

## What was wrong

The amd64 artifact that every release verification had passed on was built at
**07:17**. TASK-114 fixed 16 legibility defects between then and **20:36** — and the
shipped payload still contained every one of them:

```
archive  apps_web_..._nodes-view_tsx_1b6k2f2._.js : whitespace-nowrap font-medium = 0
build    apps_web_..._nodes-view_tsx_1b6k2f2._.js : whitespace-nowrap font-medium = 1
```

Same chunk hash, same file name, **different content**. A release that installed the
old artifact would have shipped every legibility defect this session found and
fixed.

## Why the freshness gate passed

`test-release-manifest-freshness.ts` exits 0 on the stale artifact. It verifies
that the manifest describes **itself** — the embedded digest matches the extracted
payload, the sidecar matches the archive, the archive name matches the version.

That is all true, and all irrelevant to staleness. **The gate compares the artifact
to itself and never to the source it was built from.** A perfectly self-consistent
artifact built from yesterday's source passes every check it makes.

This is the same shape as TASK-115, one layer up: a test that proves an invariant
about a value without checking the value against reality.

## The rebuild (sequential, as required)

1. re-stage the amd64 payload from the current build
   — `stage-release-artifact.ts . dist/artifact --architecture amd64`
2. rebuild the manifest from the **staged** tree
   — `release-manifest.ts build dist/artifact/release-manifest.json 1.2.0 <commit> amd64 <name> dist/artifact 6.19.3`
3. archive to a path **outside** the staged tree (a file inside the tree it archives
   produces `tar: .: file changed as we read it`)
4. write the sidecar, replace the archive, sync `dist/amd64/release-manifest.json`
   and the root `release-manifest.json`

## Verification

| gate | result |
| --- | --- |
| `test-embedded-manifest-provenance.ts` (independent recompute) | **3/3** |
| `verify-artifact.ts verify --manifest release-manifest.json` | **exit 0** |
| `test-release-manifest-freshness.ts` | **4/4** |
| real installer on Ubuntu 24.04.5 amd64 | **INSTALL EXIT: 0** |

Then, on the **installed** release at `/opt/xistance/current`:

```
nodes-view nowrap fix : 1        <- the TASK-114 fix, in production
release               : v1.2.0-20261001183847
health                : 200
nodes                 : 401
svc                   : active
```

And in the staged tree: `min-[420px]:grid-cols-2` present in 1 chunk — the 200%
text fix ships. Exactly one `text-[10px]` remains anywhere in the payload, and it
is the `<kbd>` arrow keycap in the search dialog, which is correct at 10px.

New artifact: **40,714,354 bytes**, sha256 `fa011da154382e23...`.

## What this does not close

**The arm64 artifact is stale in exactly the same way.** It was staged before any of
the UI work and carries the old payload. Rebuilding it needs the arm64 standalone
tree and its own Prisma engine, which is a longer sequence than the amd64 rebuild
above, and it cannot be *installed* on this host (QEMU's tar defect, TASK-112).

So amd64 is current and verified; arm64 is current in its source but its artifact is
not rebuilt. Both need the release run on a real runner to be authoritative anyway,
which is the same blocked decision as TASK-109/110/111.

## The lesson

**A manifest proves what an artifact CONTAINS. Only a comparison against the SOURCE
proves what it SHOULD contain.** Self-consistency is not freshness, and a gate that
checks the first while claiming the second will happily pass a stale artifact for as
long as it remains internally tidy.
