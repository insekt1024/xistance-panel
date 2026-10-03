# TASK-106 — the manifest recorded the build host's Node, not the release's

**Status: fixed, rebuilt, reinstalled, and verified on both target OSes.**

Found by diffing the installed manifest against the shipped one after TASK-98 —
a check that only exists because the identity gate compares the manifest file
itself, not just the payload digest.

## The defect

`scripts/release-manifest.ts`'s `build` CLI filled `runtime.node` with
`process.version`:

```ts
runtime: {
  node: process.version,   // the Node that BUILT the release
  ...
}
```

On this build host that is `v26.7.0`. The manifest that shipped inside the
release read:

```json
"runtime":{"next":"16.3.6","node":"v26.7.0","prisma":"6.19.3"}
```

on a target running **Node 22.23.3**. Two independent problems in one field:

1. **It named the wrong machine.** The field describes the release's runtime
   contract; `process.version` describes the build host's toolchain. A manifest
   is shipped to a target and read by whoever installs it — recording the builder's
   Node there is provenance about a machine the user will never see.
2. **The `v` prefix is inconsistent.** `next` and `prisma` are plain semver
   (`16.3.6`, `6.19.3`); `node` was `v26.7.0`. `process.version` carries the
   prefix, `process.versions.node` does not — a one-word difference in a field
   that is otherwise a bare version.

## The fix

Record the value the **installers actually enforce**:

```
scripts/release-install.sh   NODE_MIN_MAJOR=22
scripts/install.sh           NODE_MIN_MAJOR=22
```

exported as `RELEASE_NODE_MIN_MAJOR = "22"` and used by the CLI. Now the manifest
states a contract that can be checked *against the target* rather than against
the build host, and it is checkable: the installer refuses a target below it.

## Verified on a real target

Both archives rebuilt and reinstalled (`INSTALL EXIT: 0` on each):

```
xtinst:  installed manifest runtime.node : 22
         target node major              : 22
         health                         : HTTP 200   service active
xt24:    installed manifest runtime.node : 22
         target node major              : 22
         health                         : HTTP 200   service active
```

Read from inside the archive that shipped:

```
amd64: runtime={'next': '16.3.6', 'node': '22', 'prisma': '6.19.3'}
arm64: runtime={'next': '16.3.6', 'node': '22', 'prisma': '6.19.3'}
```

## The suite

`scripts/test-manifest-runtime-node.ts` — 12/12:

- the build CLI does not use `process.version` for `runtime.node`;
- the declared constant equals `NODE_MIN_MAJOR` in **both** installers;
- both installers gate on a **major-version** comparison, so a bare major is the
  right shape to record;
- a shipped manifest carries a bare major, not a `v`-prefixed or dotted value;
- non-vacuity: `v26.7.0`, `26.7.0` and a wrong major are all rejected, and the
  correct value is accepted.

### An assertion of mine that was wrong

The first run reported that `install.sh` "does not gate on a major-version
comparison". It does — via `BASH_REMATCH[1] >= NODE_MIN_MAJOR`, deliberately not
`node -v | grep -q`, which SIGPIPEs under `pipefail` (the script's own comment
says so). My assertion had been written against `release-install.sh`'s idiom only.
Corrected to accept either shape, because both installers are right and pinning
one idiom would fail the other for no reason.

That is the fourth time this session a finding was an artifact of the check
rather than the code. The pattern is consistent enough to be worth stating:
**when an assertion fails, check whether the assertion is describing the code
accurately before concluding the code is wrong.**

## The lesson

`process.version` is a build-time fact in a field that documents a runtime
contract. Any manifest field that describes the *consumer's* environment must be
sourced from the consumer's requirement, not the producer's capability — and the
installer is where that requirement is already written down.
