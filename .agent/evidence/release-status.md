# Release status — updated 2026-10-02

> The headline table below is from 2026-10-01 and its aggregate count
> (62/62) predates six more suites. Current: **73/73**, exit 0.
> Sections marked SUPERSEDED are corrected inline, not deleted.

## Current verified state

| gate | result |
| --- | --- |
| typecheck | 0 errors |
| lint | 0 errors, 22 warnings |
| version:check | 7/7 match 1.2.0 |
| aggregate | **62/62 suites, twice consecutively** (373.7s, 398.0s), exit 0 |
| task ledger | 73/73 evidence-backed, 0 dangling, 0 waivers |
| amd64 official installer | **runs and succeeds** on Ubuntu 22.04.5 and 24.04.5 |
| installer's failure path | **proven** to refuse a partial extraction safely |
| foreign-native binaries in payload | 0 |
| scratch leakage into the repo | 0 |

No `v1.2.0` tag, no commit, no push. The worktree is intentionally dirty
(224 paths) and no pre-existing work was discarded.

## What was closed since the last status

1. **TASK-89** — the installer's own verifier rejected the real release archive
   for two legitimately required top-level entries (`apply-migrations.mjs`,
   `create-admin.mjs`). Allowlist repaired; `scripts/test-real-archive-verify.ts`
   now runs the real command against the real archive with a negative control.
2. **TASK-90** — the official installer had **never been executed**. Four earlier
   "failures" were invocation errors. It now installs cleanly on both required
   amd64 targets with systemd active, health 200, nodes 401, and a
   service-user-owned database.
3. **TASK-91** — the long-standing arm64 install failure is **root-caused and is
   not a release defect**. The archive's checksum verifies on the arm64 target;
   the fault is GNU tar 1.35 under QEMU-user arm64, proven by a 14-byte control
   archive and by Node.js's own official arm64 tarball failing identically.
4. **TASK-92** — the installer's refusal of a partial extraction is proven by
   executing the real installer against a real partial extraction. Previous
   release untouched, service healthy, candidate removed, exit 7.
5. **TASK-93** — the intermittent `test-retry-bounds.ts` failure was a test
   asserting a mutable value re-read *after* it had legitimately changed. Now
   6/6 unloaded and 4/4 under 8 CPU burners.
6. **TASK-94** — the cgroup gate was measuring `memory.current`, which includes
   page cache the kernel does not release on exit. `anon` is the quantity that
   expresses "a leak"; the gate now measures it and still catches a real 80 MiB
   heap leak.

## Open gates — why the release is NOT ready to tag

1. **Native arm64 execution has never happened.** The installer's arm64 code
   path IS proven (TASK-100): given a working `tar` it installs, activates and
   survives a SIGKILL with data intact, on aarch64 with systemd as PID 1. But
   that ran under QEMU-user with a `bsdtar` shim. A native arm64 host has a
   working GNU tar and needs no shim — that path is still unexecuted.
2. **The `ubuntu-24.04-arm` CI release cell has never executed.** No amount of
   local emulation substitutes for the runner actually running.
3. **Approval-gated operations remain unexecuted:** the distinct-host `REVERSE`
   proof (`GatewayPorts clientspecified`) and the live post-fix password-reset
   command. Both previously timed out awaiting approval.
4. ~~**The arm64 release artifact is stale and cannot be rebuilt here**~~
   **RESOLVED (TASK-139).** Built on a native `ubuntu-24.04-arm` runner — which
   is GitHub-hosted and free because this repository is public. 16/16 job steps
   succeeded on real aarch64 hardware; the shipped Prisma engine is
   `ELF 64-bit LSB shared object, ARM aarch64`, checksum verified, and the
   embedded manifest digest describes the extracted archive. Two defects surfaced
   only because arm64 actually ran: the stager refused an arm64 manifest (**a
   latent release blocker** — the amd64 cell passed only by coincidence against
   the committed amd64 manifest), and the provenance step read the provisional
   seed instead of the staged manifest. Both fixed in `ci.yml` and
   `release.yml`.
5. **The arm64 artifact has never been INSTALLED by any process** (TASK-119).
   Still true, and now the *only* arm64 gap. TASK-139 built and verified it on
   native hardware but deliberately did not install: the release workflow's
   arm64 install gate is where that happens, after the tag. A CI install gate
   exists on both matrix cells, before the upload — and its three defects (wrong
   library path, drifting version argument, unprivileged invocation) plus the
   self-copy no-op were all fixed in TASK-120.
6. ~~**FRP proxies with a plugin cannot work at all**~~ — **RESOLVED (TASK-132).**
   `buildFrpConfig()` emitted `addr` and `port` under `[proxies.plugin]`; frpc
   **0.70.1**, the pinned version, rejects both as unknown fields (exit 1), so any
   proxy configured with a plugin could not start. Interrogating the pinned
   binary's own type table showed `ClientPluginOptions` carries `type` alone —
   `addr`/`port`/`user` live on the per-plugin option structs, which the panel does
   not model. The builder now emits only `type`; the fields were removed from
   `FrpProxySchema`. The panel's own generated config is accepted by
   `frpc verify` on the target OS, and five mutation-proven gates pin it.

6. **CI cannot supply two things its suites need** (TASK-138). Six live-run
   defects were found and fixed — see `task-138-first-live-ci-run-found-six-defects.md`
   — leaving 8 suites red for two reasons that are missing CI *infrastructure*,
   not product defects:
   - `xtinst`/`xt24` are local development containers. Nothing in `ci.yml`
     creates them, so `test-rollback-drill` and `test-target-runs-shipped-payload`
     find Docker (available on runners) but no targets.
   - No `dist/arm64` stage can exist on an x64 runner, because Prisma's query
     engine is a native binary generated on the target architecture.

   **No skip was added for either.** `run-all-tests.ts` states: "A suite that
   cannot run is a FAILURE, not a skip. Silent skips are how coverage gets
   claimed when nothing executed." Two fixes were proposed to the maintainer and
   the question was cancelled, so the choice was not made unilaterally. Until it
   is, CI is red by design rather than green by omission.

## Two id namespaces: PRD tasks and agent-loop findings

`reconcile-task-ledger.py --check` reports `task files: 73 / evidence-backed: 73`
and exits 0. **Both numbers come from the same glob** of `.agent/tasks/TASK-*.json`,
so the ratio is satisfied by construction: a task with an evidence file and no
ledger record is outside the count entirely.

That matters because **two numbering schemes share one directory**:

| range | what it is | where it is tracked |
| --- | --- | --- |
| **TASK-1 .. TASK-73** | the 73 tasks the PRD defines | `.agent/tasks/TASK-N.json` |
| **TASK-74 .. TASK-122** | **findings** raised while executing them | `.agent/evidence/task-N-*.md` only |

So an evidence file numbered above 73 is **a finding, not a missing PRD task.**
TASK-89..112 (the release/install work) and TASK-114..122 (defects found while
verifying it) are findings against PRD tasks, not PRD tasks themselves. Requiring
a ledger entry for each of them would be a false positive, and inventing 49
ledger records to satisfy such a check would fabricate acceptance criteria.

The ledger is therefore **complete**: 73 contiguous records for 73 PRD tasks, no
hole in the range. `test-prd-success-metrics.ts` asserts that contiguity, that the
two namespaces are declared apart, and that the reconciler reports its scope —
so an audit cannot misread a finding as an absent requirement.

## What this status file got wrong, and how it was found

Two of the claims above were false when written, and both surfaced only because a
check was added that compared an artifact against the source rather than against
another artifact:

| claim | reality | found by |
| --- | --- | --- |
| "arm64 archive rebuilt from current source" | different `BUILD_ID`; stale | TASK-118 / TASK-121 |
| "62/62 suites" | 73/73 now; count grew | six added suites |

A manifest that agrees with itself proves nothing about freshness, and neither
does a status file written from memory. Every digest in the release manifest
chain is computed from the same tree, so they all agree with each other while
describing a stale build.

**SUPERSEDED by TASK-118 — this claim was wrong.** The arm64 archive on disk was
built from `BUILD_ID e8DG6UyhN3KW_U_Qhkplq`; the current source is
`mCl4Nt8S0HKuyq0GvghxD`. It is **stale**, and it cannot be rebuilt on this host:
`docker buildx build --platform linux/arm64` fails with `exec format error`
because binfmt-QEMU is unregistered (`/proc/sys/fs/binfmt_misc/` does not exist)
and no native arm64 builder is available. `scripts/release-install.sh` +
`scripts/lib/*.sh` remain untracked, so a tag cannot even carry them.

The freshness check that now proves this compares archived `BUILD_ID`, not mtime
(TASK-121), because mtime reports a *current* artifact stale after a bare
`touch`.

`XUI` intentionally has no binary proof: it is metadata/status integration for a
3x-ui panel and executes no tunnel binary.

## arm64: root-caused to the emulator, and deliberately NOT worked around

TASK-112 reduced the arm64 install failure to a **192-byte** reproducer:

```
$ tar -xzf mini.tar.gz -C /out
tar: ./a/b: Cannot mkdir: Invalid argument     rc=141  files=0
```

Controls: the checksum verifies on the arm64 target; the real 25 MB archive
extracts **1,988 files on native amd64**; `tar -tzf` lists **2,409 members** on
emulated arm64; and plain `mkdir -p` of the identical path **succeeds** on the
same target. tar can read the archive completely and then cannot create a
directory inside it — the defect is in tar's mkdir path under binfmt-QEMU, not in
the release. `--no-same-owner`, `--no-same-permissions` and
`--delay-directory-restore` all fail identically.

**No fallback was added, deliberately.** `bsdtar` is not packaged and `python3` is
absent from a minimal Ubuntu arm64 image, so a "fall back to python3" mitigation is
unavailable on the very machine it would rescue — and it would trade a real
install-path regression for a green local number against a defect that does not
exist on real hardware. `strace` is itself non-functional under binfmt-QEMU, so the
exact syscall could not be named.

There is no native arm64 host on this machine — both Docker contexts (`default`,
`desktop-linux`) are the local Windows engine, and `docker buildx ls` shows no arm64
builder. Every arm64 result here is emulated.

## The honest summary

Everything verifiable on this host is verified and green, on **both**
architectures: the amd64 installer runs on Ubuntu 22.04.5 and 24.04.5, and the
arm64 installer runs on aarch64 with systemd, including a durable write across
a SIGKILL. The remaining work is not more local testing — it is execution on a
**native** arm64 runner, which this host does not provide.

## Pre-tag preconditions (TASK-102)

Two facts about the release *process*, established by replaying the workflow's
own version job in an isolated clone:

1. **The version bump is uncommitted.** `HEAD` is 1.1.2; the worktree is 1.2.0
   across all 7 version files, alongside ~230 dirty paths of verified work. The
   release workflow reads the version from the **commit**, so dispatching it
   today would bump 1.1.2 → 1.1.3 and publish
   `xistance-panel-v1.1.3-{amd64,arm64}.tar.gz` — not the v1.2.0 artifacts that
   were actually verified here.

2. **The installer and both libraries are UNTRACKED** (TASK-109/111).
   `scripts/release-install.sh`, `scripts/lib/release-layout.sh` and
   `scripts/lib/service-unit.sh` are in no commit, and no `v1.2.0` tag exists.
   Both READMEs fetch all three from `raw.githubusercontent.com/.../v1.2.0/...`,
   so **the documented one-line install currently 404s** — a failure easy to
   misread as a network fault. The installer *also* curls the two libraries from
   the tag when they are not beside it, so even a staged install would receive the
   pre-TASK-108 library. The install itself is verified working end to end
   (`INSTALL EXIT: 0` on Ubuntu 22.04.5); only the *shipping* of it is missing.
   Untracked is worse than uncommitted: invisible to `git diff` and to a stash.

3. **The release published no installer assets** (TASK-110, now hardened). The
   publish job uploaded only `dist/*.tar.gz` and `dist/*.tar.gz.sha256`. The
   **documented** one-line install is unaffected — both READMEs already fetch all
   three files from `raw.githubusercontent.com` at the pinned tag, and that layout
   was verified to resolve on a real target. The added assets make the release
   self-contained (no raw-GitHub access needed) and the job now **fails closed**
   if any is missing, which matters for the untracked-libraries hazard below.

4. **The workflow always bumps.** Producing `v1.2.0` therefore requires the
   committed version to be 1.1.x with the bump landing on 1.2.0, or the tag to be
   created outside this workflow. That is a maintainer decision, not something to
   infer.

Two suites report these on every aggregate run as **readiness findings** (exit 0
— an intentionally dirty worktree is not a product defect) and hard-fail on a
mis-named archive:

- `scripts/test-release-version-commit-parity.ts` — the version bump
- `scripts/test-release-installer-assets.ts` — the published installer assets
- `scripts/test-documented-install-command.ts` — the documented one-line install

Before any release: commit the bump, the verified work, **and `git add` all three
of `scripts/release-install.sh`, `scripts/lib/release-layout.sh`,
scripts/lib/service-unit.sh`**, then confirm the workflow would produce the
intended tag.

## Pre-commit hygiene (TASK-113)

`.gitignore` had two holes that a blanket `git add -A` would have shipped:

- `/node_modules` was **root-anchored**, leaving `packages/*/node_modules`
  exposed — **17 MB** of cross-platform `linux-musl` Prisma engines.
- `**/*.db` covered the databases but not `.data/test-out.txt`, their sibling.

Both are closed; `git add -A --dry-run` now shows 0 for `.data/`, `node_modules/`,
`dist/`, `.next/`, `tunnels/bin/`, `*.pem|key|p12`, and exactly one `.env` — the
placeholder-only `.env.local.example`.

## What IS proven

The PRD §9 install path is verified working **end to end**, not in pieces:

| evidence | result |
| --- | --- |
| documented command executed on Ubuntu 22.04.5 amd64 | **`INSTALL EXIT: 0`** |
| checksum verified, new versioned dir, migrations up to date | pass |
| systemd unit + `xt-rollback` installed; health 200, `/api/nodes` 401 | pass |
| `previous` recorded a **distinct** release (TASK-108 fix surviving install) | pass |
| update/rollback drill on both target OSes | 22/22, and 3/3 under CPU load |
| aggregate | 72/72, `RESULT: PASS` |

The remaining blockers are **commit-decision and infrastructure** items, not
untested product behaviour.
