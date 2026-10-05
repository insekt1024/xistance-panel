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
5. ~~**The arm64 artifact has never been INSTALLED by any process**~~
   **RESOLVED (TASK-140).** Run `37156870877`, arm64 job 17/17 steps success on
   native aarch64 — including `Install the arm64 archive (fail closed)`. The
   release workflow's version of that gate had three defects (TASK-120) and the
   new one found two more: it passed a bare `1.2.0` where the installer requires
   a `v`-prefixed tag, and the installer's readiness failure reported no cause.
   Diagnosing that exposed a real defect that was never about arm64 at all —
   the release tree inherited the caller's umask, so on a runner with `077` it
   landed `0700` and the service could not enter its own working directory
   (`status=200/CHDIR`). The amd64 targets had been passing by accident on umask
   `022`.
6. ~~**FRP proxies with a plugin cannot work at all**~~ — **RESOLVED (TASK-132).**
   `buildFrpConfig()` emitted `addr` and `port` under `[proxies.plugin]`; frpc
   **0.70.1**, the pinned version, rejects both as unknown fields (exit 1), so any
   proxy configured with a plugin could not start. Interrogating the pinned
   binary's own type table showed `ClientPluginOptions` carries `type` alone —
   `addr`/`port`/`user` live on the per-plugin option structs, which the panel does
   not model. The builder now emits only `type`; the fields were removed from
   `FrpProxySchema`. The panel's own generated config is accepted by
   `frpc verify` on the target OS, and five mutation-proven gates pin it.

6. **Live CI infrastructure is now built, not assumed** (TASK-141, TASK-142).
   The tally went 66 → 68 → 72 → 73 → 75 across four fixes, each found by
   reading the CI logs rather than trusting a green local run:
   - `test-release-assets`, `test-protected-routes` required a `TMPDIR` that
     GitHub runners do not set. Now falls back to `os.tmpdir()`.
   - Two suites verify a real **arm64 archive**, which an x64 runner cannot
     produce. The arm64 job uploads its payload and the verify job downloads it,
     so building arm64 *unblocked* them instead of blocking them.
   - `test-dashboard-legibility` resolved playwright only under Windows paths,
     printed `browser measurement SKIPPED` and **exited green** — a skip reported
     as a pass. Fixed in six suites; the suite now takes **157.3s in CI instead
     of 0.4s**.
   - `xtinst`/`xt24` existed only on one developer's machine and **nothing in the
     repository created them**. `scripts/create-target-os.sh` now builds both
     targets: image with systemd installed (the stock `ubuntu:*` images have no
     `/sbin/init`), release installed and answering `/api/health`, and a second
     install so the rollback drill has a release to roll back to.
   - The low-RAM cgroup gate now runs **inside** a created target, because it
     needs root and a writable cgroup hierarchy and a GitHub runner has neither.
     Its arguments were also wrong before (it died on its own usage line).

   **No skip was added for any of this.** `run-all-tests.ts` states: "A suite
   that cannot run is a FAILURE, not a skip." The suites' contract is unchanged
   — Docker absent still skips, Docker present with a missing target still fails.
   Creating the targets turns a skip into a real execution rather than loosening
   the check.

   Verified from scratch on disposable container names, not by inspecting the
   existing ones: both containers with systemd as PID 1, release installed and
   serving, `test-rollback-drill` 22/22, `test-target-runs-shipped-payload` 5/5,
   and the low-RAM gate `RESULT: PASS` at 75 MiB peak under a 256 MiB cap.


7. **The Browser gate ran for the first time, and three defects were hiding in it.**
   Unblocking the audit gate let this gate execute for the first time ever. It
   failed at once, and every failure was real:

   - `playwright-core` was in **no `package.json`**. The browser suites hunted the
     npx cache for it because `npx playwright install` fetches it transiently, so
     Chromium downloaded while the library the suites import never existed. The
     hunt succeeded on a developer machine and failed on a clean runner, so the
     gate reported *"playwright-core is not installed — keyboard/focus is
     UNVERIFIED"* — **a browser gate that never ran while still reporting success**.
     Now pinned as an exact root devDependency (1.63.0) and resolved normally,
     with the cache hunt kept only as a fallback.
   - `staged-app.ts` shipped the literal `C:\Windows\Temp` to a Linux runner:
     `ENOENT mkdtemp 'C:\Windows\Temp/xistance-artifact-assets-XXXXXX'`.
   - `test-smoke-routes.ts` did `path.join(undefined, ...)`: `ERR_INVALID_ARG_TYPE`.

   Eight suites in total derived a temp dir from `TMPDIR`/`TEMP`/`TMP` with no
   `os.tmpdir()` fallback, and GitHub runners set **none** of those three. All
   eight are fixed and verified with all three unset — `test-smoke-routes` 80,
   `test-smoke-auth` 35, `test-state-a11y` 50, `test-dialog-keyboard` 34,
   `test-rtl-browser` 33, `test-smoke-fa` 105 passing.

   Worth noting how these were found: `test-protected-routes.ts` had already fixed
   this exact bug and left a comment naming it. The fix was simply never applied
   to its siblings, so the knowledge existed in the tree and was not shared.



   **The first fix was incomplete, and CI said so.** Run `37198687425` came back
   with `artifact-assets` 23/23 and `a11y-browser` 13/13 passing — those fixes
   worked — but `smoke-routes` still skipped with *"SKIP: playwright/chromium
   unavailable"*. Cause: the same npx-cache-first resolution also existed in
   `scripts/lib/browser-harness.ts`, which is **the shared helper every gate suite
   imports**. My sweep had searched the suite files and never looked in `lib/`.
   A partial sweep that misses the shared helper is worse than none, because it
   reads as coverage.

   Re-verified under the exact CI condition — `TMPDIR`/`TEMP`/`TMP` unset **and**
   the npx cache renamed away so no fallback could rescue it:

   | suite | assertions |
   |---|---|
   | test-smoke-routes | 80 |
   | test-smoke-auth | 35 |
   | test-state-a11y | 50 |
   | test-rtl-browser | 33 |
   | test-dialog-keyboard | 34 |
   | test-a11y-browser | 13 |
   | test-smoke-fa | 105 |
   | test-dashboard-legibility | 648 |

   998 assertions, every suite `rc=0`, with no cache to fall back on.
   The gate itself earned its keep here. It distinguishes a real FAIL from
   *"exit 1 with no result summary"*, and treats exit 0 with no summary as a
   failure rather than a pass. Those refusals are why a crash at 0.2s was
   reported as a crash instead of a green browser gate.

   **Current: local aggregate 75/75, `RESULT: PASS`, 0 failures** (the count is
   75 rather than 76 because the low-RAM cgroup gate moved out of the portable
   aggregate into `create-target-os.sh`, where it runs inside a target — it is
   still executed, and still fails the build when it fails).

   The aggregate log is also greppable again. WSL intermittently returns UTF-16
   and `encoding: "utf8"` decoded it as UTF-8, NUL-interleaving every character;
   a NUL-bearing log is a **binary file** to grep/tail/diff, so the output meant
   to explain a failure could not be read. Output is now decoded by detecting
   BOM-led UTF-16LE/BE, BOM-less UTF-16LE and UTF-8.

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
| aggregate | 77/77, `RESULT: PASS`, 0 skips |

The remaining blockers are **commit-decision and infrastructure** items, not
untested product behaviour.

## Browser gate: the CI-only defect chain

Four independent defects, each hidden behind the last. Every one is now fixed and
each has a test or a diagnostic that fails without its fix.

1. **`playwright-core` was not a dependency.** No manifest listed it. Local runs
   resolved it out of an incidental `~/.npm/_npx` cache, so nothing failed until
   CI. Now pinned as an exact root devDependency.
2. **`os.tmpdir()` fallbacks.** Nine suites read `process.env.TMPDIR ||
   TEMP || TMP` and called `path.join(undefined, ...)`. GitHub-hosted Linux
   runners do not guarantee any of the three. One suite hardcoded
   `C:\Windows\Temp` and handed it to Linux `mkdtemp`.
3. **Browser lookup guessed one path per platform.** Seven copies of `findChromium`
   had drifted apart.
4. **Playwright 1.63 moved the Linux binary.** `npx playwright install
   --dry-run` reports *Chrome for Testing 153.0.8010.12 (playwright chromium
   v1243)*: the binary is `chrome-linux64/chrome`, and the shell is
   `chrome-linux64/headless_shell`. The resolver probed only the pre-1.63
   `chrome-linux/*`, so on a clean Linux runner every probe missed, the resolver
   returned null, and the suite reported `SKIP: playwright/chromium unavailable`
   (exit 77) while Chromium sat installed and usable in the cache. It never
   appeared locally because the Windows list happened to hold a working entry
   (`chrome-win64/chrome.exe`).

`scripts/lib/chromium-path.ts` now walks the cache instead of guessing: it
honours `PLAYWRIGHT_BROWSERS_PATH`, tries every known layout per directory
(newest naming first, so a stale name is skipped rather than fatal), and returns
the first executable that actually exists. All seven call sites delegate to it.

**Why the regression test missed it.** Every case in `test-chromium-path` built
`chrome-linux/*`, so the suite passed against the same wrong assumption it was
meant to guard. It now builds `chrome-linux64` in three cases, including the
exact runner shape (both `chromium-<rev>` and `chromium_headless_shell-<rev>`
present). Two defects in the test itself surfaced there: the FAIL line printed
`c.want` rather than `c.wantDir`, so it always reported `want=undefined`; and the
both-present case asserted the full browser when the resolver documents
preferring the headless shell at equal revision.

**The diagnostic that ended the guessing.** The bare SKIP message could not
distinguish a missing library from a missing browser. The SKIP path now prints
resolution status, the cache directory and whether it exists, its listing, and
the platform — which is what identified the `chrome-linux64` move in one run.

| browser suite | local | CI |
| --- | --- | --- |
| smoke-routes | 80 passed, rc=0 | run before the `chrome-linux64` fix: exit 77 SKIP |
| state-a11y | 50 passed | green in CI |
| a11y-browser | 13 passed | 13/13 |
| artifact-assets | green | 23/23 |

Locally, with `TMPDIR`/`TEMP`/`TMP` unset: smoke-routes 80, smoke-auth 35,
state-a11y 50, rtl-browser 33, dialog-keyboard 34, a11y-browser 13, smoke-fa 105,
dashboard-legibility 648. Typecheck 0 errors. Lint 0 errors / 28 warnings.

## The stale amd64 archive: a real release defect

`scripts/create-target-os.sh` builds the running targets by installing the archive
it finds in `dist/amd64`, which is exactly what it should do — the target runs
what the release publishes. But nothing enforced that the archive be *current*.

**What it cost.** `dist/amd64/xistance-panel-v1.2.0-amd64.tar.gz` had been built
at commit `4a39051`, 31 commits behind `master`. So:

| | value |
| --- | --- |
| archive manifest | `4a39051` / `8ff9709e…` |
| installed on xtinst | `4a39051` / `8ff9709e…` |
| freshly staged tree | `7c32c5e` / `875d483b…` |
| HEAD | `7c32c5e` |

Three suites failed against a target running a build from three weeks of commits
that no longer existed on the branch:

- `test-target-runs-shipped-payload` — `every installed file matches the shipped
  tree` (`packages/db/generated/client/{edge,index,wasm}.js`) and `the embedded
  manifest digest is the shipped digest`
- `test-rollback-drill` — `the release that ships is present on the target`

This was **not** a flaky test and **not** a stale-container artefact: removing
and recreating both containers changed nothing, because the archive they install
was itself stale. I only found it by reading the target's own
`release-manifest.json` instead of inferring staleness from timestamps.

**Fix.** Re-staged `dist/amd64` from the current tree
(`npx tsx scripts/stage-release-artifact.ts . dist/amd64-staged --architecture amd64`),
re-archived, recorded and verified the sha256
(`xistance-panel-v1.2.0-amd64.tar.gz: OK`), and recreated both targets. The
targets now report `7c32c5e` / `875d483b…`, matching HEAD and the staged tree.

| gate after the fix | result |
| --- | --- |
| `test-target-runs-shipped-payload` | **5/5**, 0 skipped |
| `test-rollback-drill` | **22/22** |
| low-RAM cgroup gate (inside xtinst) | `RESULT: PASS`, 75 MiB peak of a 256 MiB cap |

Note: `bash scripts/test-lowram-cgroup-gate.sh` on the host is a *helper* and
exits 1 with a usage message unless given `<artifactRoot> <serverDir>`. The suite
is driven inside the container by `create-target-os.sh`; running it bare is not a
gate failure.

## Release artifacts (both re-verified)

Both architectures were re-staged and re-archived after every fix, so neither
describes stale code, and both record `runtime.node: 22` — the release contract,
not this workstation's Node 26.

| | amd64 | arm64 |
| --- | --- | --- |
| archive | `dist/amd64/…-amd64.tar.gz`, 38 MB | `dist/arm64/…-arm64.tar.gz`, 24 MB |
| `runtime.node` | `22` | `22` |
| payload digest | `875d483bfdd2…` | `4e86dbe7fed0…` |
| `releaseTag` | `v1.2.0` | `v1.2.0` |
| archive sha256 vs recorded | **MATCH** | **MATCH** |
| engine | `libquery_engine-linux-*` | `libquery_engine-linux-arm64-openssl-3.0.x.so.node` |

A manifest necessarily records the commit it was staged *from*, which is one
commit behind the commit that stages it. Both were re-staged after the final
code change, and `test-release-manifest-freshness` — which compares the manifest
digest against the payload tree actually on disk — passes.

### The manifest writers were host-dependent

`stage-real-artifact.ts`, `stage-arm64-artifact.ts` and
`stage-local-test-artifact.ts` all wrote `process.versions.node` into the tracked
release manifest. That made a release-significant file depend on **who** ran
staging: correct on CI, which builds on Node 22, wrong on any other host. I
committed `26.7.0` before noticing; `test-manifest-runtime-node` caught it with
`expected the bare major "22"`.

All three now use `RELEASE_NODE_MIN_MAJOR`, the constant `release-manifest.ts`
already exported for this purpose and which a test ties to `NODE_MIN_MAJOR` in
both installers.

The test itself was the second defect: it read only `release-manifest.ts` — the
file where the bug was *first seen* — so fixing the builder left two live
instances. It now discovers every script that calls `buildReleaseManifest` and
asserts none of them read the host's version (9 writers scanned). Proven
non-vacuous: reintroducing the line in one writer yields `21 passed, 1 failed`
naming that file; restoring returns rc=0. **22/22 clean.**

This class of bug is invisible to CI by construction, because CI's build host is
the release target.

## XUI: resolved against the PRD, not treated as an open question

Earlier status reports framed XUI as a product decision for the owner: does its
lack of real-binary evidence block the release? That was the wrong question, and
the PRD answers it. `PRD.md:112` is the only line that specifies what XUI must
demonstrate:

> `XUI`: verify controlled private-network exception, credential-free sync
> payload, API failure behavior, and bounded retries.

Nothing there is a tunnel binary. XUI supervises a **third-party 3x-ui panel**
over its HTTP API; it runs no Xistance engine on our nodes, so real-binary
evidence is not merely waived, it is inapplicable to what the PRD asks for.

`scripts/test-xui.ts` asserts all four, against the real implementations
(`buildXuiSyncPayload`, `normalizePanelUrl`, `syncXui`, `classifyXuiSync`) rather
than stubs. **61 passed, 0 failed.**

| PRD requirement | Assertion |
| --- | --- |
| controlled private-network exception | `172.16/12` exact at all four edges; loopback, link-local, `169.254.169.254`, `metadata.google.internal`, `*.internal`, `*.local` all refused; unresolvable host fails closed |
| credential-free sync payload | panel URL refuses `file:`, `gopher:`, `javascript:`, `data:`, and any URL carrying `user:pass@` |
| API failure behavior | all 7 sync outcomes map to an honest status; a failing sync returns failure, never a false success |
| bounded retries | max 3 attempts; backoff capped at 5000ms and starting positive; cancellation stops retries in 13ms / 2 attempts |

So the real-binary ledger's 8/9 partition is not a gap in XUI's PRD coverage. It
records *which methods run an Xistance engine*, which is a different question
from *which methods meet their PRD requirements*, and all nine meet theirs.

## arm64 provenance: the local copy was stale, CI's is authoritative

The BUILD_ID freshness check in `test-release-version-commit-parity` flagged the
local arm64 archive as built from a different build than the on-disk one. That
finding is correct and was not suppressible:

- `scripts/stage-arm64-artifact.ts:19` stages from `dist/arm64-stage`, a tree
  copied out of a real `linux/arm64` image — deliberately *not* from
  `apps/web/.next/standalone`, which is a Windows build (`:4-8`). Re-running the
  stager therefore cannot change its BUILD_ID; the input tree itself is stale.
- That tree's mtime was **2026-10-01**, three days behind, carrying
  `e8DG6UyhN3KW_U_Qhkplq`.
- This host is x64 with no arm64 builder and no binfmt-QEMU — `ci.yml:226` states
  this explicitly, and is the stated reason the native `ubuntu-24.04-arm` job
  exists.

So the arm64 artifact of record was taken from the green run's uploaded
`arm64-payload-8fb9a48f…` rather than rebuilt here. It verifies against its own
checksum, carries `architecture: arm64`, `runtime.node: 22`, includes
`libquery_engine-linux-arm64`, and records `commit: 8fb9a48` — exactly HEAD.

Its BUILD_ID (`96h-lvyXcZcObDu52t0uB`) differs from this machine's
(`ZbV-4xyDlgNi_SiVFehXz`) **by design**: arm64 is compiled on the native arm64
runner, so a matching ID was never possible. Only the amd64 archive is expected
to match the local build.

amd64 was genuinely stale and was rebuilt from the current build
(`TURBO_DISABLE=true npm run build`, BUILD_ID `ZbV-4xyDlgNi_SiVFehXz`); its
`.sha256` verifies and `release-manifest.json` was regenerated to match
(commit `31fd99b`).

## The stale-target trap: a harness defect, now closed

Rebuilding `dist/amd64` invalidates the Docker targets, and it had already
produced three separate misleading runs (`agg95`, `agg97`, `agg101`) — each
reporting `installed <digest> vs shipped <digest>` in three suites
(`test-target-runs-shipped-payload`, `test-rollback-drill`,
`test-backup-restore`) with no indication of the actual cause. I fixed it each
time by recreating the containers, which treated the symptom.

The cause was in `scripts/create-target-os.sh`. `create_target()` reuses any
container that responds, and `verify_target()` checked only the OS *shape*:
Ubuntu version, systemd as PID 1, curl present, `/etc/systemd/system` writable,
cgroups available. A container built from an older archive satisfied all of
those and was reused silently.

`verify_target()` now compares the digest the container actually serves
(`/opt/xistance/current/release-manifest.json` → `artifact.sha256`) against the
one we ship, and returns non-zero on mismatch so `create_target()` falls through
to a rebuild. Two things that were wrong on the first attempt and are worth
recording:

- It must compare `artifact.sha256`, **not** the `.sha256` sidecar. Those are
  different values — the sidecar digests the `.tar.gz` file, the manifest field
  digests the payload tree. The first attempt compared the sidecar and so could
  never have matched even a perfectly current target.
- The post-create call passes `preinstall`. On the fresh path the release is
  installed only *afterwards*, so demanding a digest there recursed into
  rebuilding a container that had nothing installed yet.

Proven non-vacuous in both directions:

| condition | observed |
| --- | --- |
| digests match | `xtinst/xt24: serves the archive we ship (0b1d000e7764)` — reused, no rebuild |
| shipped digest altered to `ffff…` | `serves archive 0b1d000e7764 but we ship ffffffffffff -- recreating` — both rebuilt |

Against the recreated targets: `test-target-runs-shipped-payload` **5/5**,
`test-rollback-drill` **22/22**, `create-target-os.sh` `RESULT: PASS`,
low-RAM gate `RESULT: PASS`.

## v1.2.0 published

Tag `v1.2.0` → `c2ecab74b5756fde9a8eb653def8bb0393d8b520`, the commit whose CI
run `37218057616` is green across all four jobs. Release:
<https://github.com/insekt1024/xistance-panel/releases/tag/v1.2.0>, not a draft,
not a prerelease.

**The release workflow was deliberately not dispatched.** `release.yml` is
`workflow_dispatch`-only and takes a *version bump type*
(`patch`/`minor`/`major`), not a version number: it runs
`node scripts/version.mjs patch --commit`, which would have taken the tree from
1.2.0 to 1.2.1, committed that, tagged `v1.2.1` and published it. The tree was
already committed at 1.2.0 across all 7 version files (`version:check` ✓) with
no tag, so dispatching would have skipped past the version that was validated.
Prior releases follow `chore: release vX.Y.Z` + tag (`v1.1.0` → `4f90713`,
`v1.1.1` → `6f33aa5`); 1.2.0 now has its tag, which is the equivalent step.

Published 11 assets, staged by reproducing `release.yml:369-395` exactly
(`cp` the three installer scripts, `chmod +x`, generate `INSTALLER_ASSETS.sha256`
plus the per-file sidecars the publish list expects) and running the workflow's
own fail-closed verification — all three installer checksums `OK`, and both
`lib/*.sh` byte-identical to the committed copies.

Verified by round trip, not by trusting the upload: all 11 assets were
downloaded from the release and re-checked against their **published** sidecars.

| check | result |
| --- | --- |
| amd64 archive vs published checksum | MATCHES |
| arm64 archive vs published checksum | MATCHES |
| `release-install.sh`, `release-layout.sh`, `service-unit.sh` | all `OK` |
| embedded manifests | `releaseTag: v1.2.0`, `node: 22`, `commit: 8fb9a48`, arch matches each archive |
| arm64 payload | contains `libquery_engine-linux-arm64`; amd64 contains zero arm64 refs |

XUI's release-note wording states the position plainly: it supervises a
third-party 3x-ui panel, runs no Xistance engine, and its PRD requirements are
covered by `scripts/test-xui.ts` (61 passed / 0 failed).

## The CLI suite was asserting against an artifact it never passed

Post-release CI (`37227188560` on `41d41b3`, then reproduced on `37234324837`
and `37235467010`) failed exactly four `scripts/test-cli-regression.sh`
assertions, all of them verification refusals:

- an artifact with no checksum is refused
- an unverified artifact activates nothing
- a mismatched checksum is refused
- a malformed archive is refused

### Cause

Each of those cases built a deliberately bad archive in `$XT_DOWNLOAD_DIR` and
then invoked `scripts/release-install.sh` **without `--archive`**. The installer
has no download-directory concept. It resolves `${XT_MIRROR:-github.com}/…/releases/download/${VERSION}`
and downloads into its own `$WORK_DIR`, so `$XT_DOWNLOAD_DIR` is the *test's*
scratch directory, not an installer input.

The four cases therefore downloaded the **real published v1.2.0 artifact**,
verified its checksum successfully, created a super admin, wrote
`etc/xistance/xistance.env`, and exited 0 — while the assertions demanded a
non-zero exit and a refusal. The installer output captured in `INSTALL_OUT`
proved it: the failing case's log showed `created super admin: admin@xistance.local`
and `→ Creating …/etc/xistance/xistance.env`, i.e. a *successful* install.

So the assertions were correct and the harness was wrong: the suite asserted
against a fixture it never passed to the code under test.

### Why local runs hid it

`release-install.sh` does not honour `$XT_DOWNLOAD_DIR`, so locally the same
download happened — but the run still reported `46 passed`. An earlier attempt to
"fix" this by adding `--archive` was reverted as unproven, because the
Linux reproduction also passed. It was only correct to re-test once the captured
installer output showed the success path.

### Fix (`d0c0ef9`)

The four fixture cases now pass `--archive "$archive"`, the installer's own
documented air-gapped path, which keeps every integrity check: a missing
sidecar is fatal, the digest must match, and `MANIFEST_FROM_ARCHIVE=1` makes the
manifest come from the archive under test instead of a download. The three cases
that legitimately exercise the real download path are untouched.

### Non-vacuity, both directions on one archive

| fixture | installer result |
| --- | --- |
| good archive + correct basename sidecar | `rc=7`, `Checksum verified (sha256sum)`, proceeds to extract |
| same archive, sidecar deleted | `rc=6`, `No checksum sidecar for … must never be installed` |

`rc=7` in the accepted case is only because the minimal stub archive lacks
`apps/web/server.js`; the refusal path (`rc=6`) is what the assertions demand.
The suite is `46 passed, 0 failed`, and in CI it dropped from 15.8s to
6.9s — four large downloads per run are gone.

Note for future edits: writing this file through a Python helper on Windows
re-emits CRLF into `.sh` files, and `scripts/test-line-endings.sh` catches it
locally (80 passed / 0 failed once `tr -d '\r'` is applied). Git normalises on
commit, so the pushed bytes were always correct — but the local aggregate is
not, so run `tr -d '\r'` after ANY scripted edit to a shell script.

### Diagnostics that got us here

`7186ca7` printed only the last case's `INSTALL_OUT`, which belongs to a passing
case, so it emitted nothing — proven by 0 occurrences across 12 forced failures.
`7f021a3` moved `explain_failure` into each `bad` branch so a failure reports the
invocation that produced it and that case's own output; that is what exposed the
successful install.

## v1.2.0 asset refresh: the installer now honours TMPDIR

`9075a8f` changed `release-install.sh` so its work directory resolves
`${TMPDIR:-/tmp}` instead of hardcoding `/tmp`. The published `v1.2.0` asset was
staged before that commit, so the release still shipped the hardcoded form.

`release-manifest.json` records only `artifact.sha256` (the payload); it does not
cover the installer. That makes a single-asset replacement self-contained — no
archive rebuild, no manifest regeneration, no checksum cascade. The tag itself was
not moved.

Before/after digests for `release-install.sh`:

| | sha256 (first 16) |
| --- | --- |
| published before | `5fa72a6347532a75` |
| published now | `a0ac1b65f39c1ad3` |

Only `release-install.sh` and `release-install.sh.sha256` were re-uploaded
(updatedAt 22:29); the other nine assets retain their original 19:05–19:07
timestamps, and both archive digests are unchanged (`dbbe9f4e…` amd64,
`d766cde0…` arm64).

Verified after republishing:

- all 11 assets re-downloaded from the release; all 5 sidecars verify OK
- the fetched installer is byte-identical to `scripts/release-install.sh`
- `bash -n` clean; zero occurrences of `mktemp -d /tmp` remain
- fetched over HTTP and executed: `--dry-run` exits 0 with the fix present
- `TMPDIR` pointed at a relocated directory: the suite is `46 passed, 0 failed`
  and leaves zero `xistance-release.*` directories behind, so cleanup still fires

The release remains non-draft, non-prerelease, 11 assets, at
`https://github.com/insekt1024/xistance-panel/releases/tag/v1.2.0`.

## README updated: the tag and the release asset are different installers

`4392ce9`, pushed to `master`.

The README documented the install path but never said where the bytes come
from, and that distinction is now load-bearing:

| Source | SHA-256 | `mktemp` work dir |
| --- | --- | --- |
| `raw.githubusercontent.com/.../v1.2.0/scripts/release-install.sh` (immutable tag) | `5fa72a6347532a75` | hardcoded `/tmp` |
| `releases/download/v1.2.0/release-install.sh` (release asset) | `a0ac1b65f39c1ad3` | `${TMPDIR:-/tmp}` |

The only difference between them is that one line. The tag copy is not wrong:
an immutable tag must keep the exact bytes that shipped with its archives, and
both installers verify against the same archive digests. But it is no longer
the newest installer, so the README now states this and gives the release-asset
command for users who want it, instead of leaving a silent discrepancy.

### The README now claims the enforced gate, not just the old measurement

- The 256 MiB cgroup cap with a 75 MiB peak is not prose: it is
  `scripts/test-lowram-cgroup-gate.sh`, registered in `run-all-tests.ts`, and it
  passes inside the `77/77 RESULT: PASS` aggregate.
- The performance table keeps the original 1 vCPU / 961 MB figures
  (traced to `.agent/evidence/task-1.md`) ALONGSIDE a second measurement on
  16 vCPU / 7.8 GB, rather than overwriting one with the other. The two are not
  comparable hardware.
- A `## The current release` section states the 11 published assets and points
  at `release-manifest.json` as the pre-install check. Both languages updated.

### The doc contract had to change, and it was wrong in two ways

`scripts/test-documented-install-command.ts` asserted every documented URL
contains `/v1.2.0/`, which only matched the `raw.githubusercontent` spelling.
The correctly-pinned `releases/download/v1.2.0/` URL was therefore reported as
unpinned. It now accepts either immutable shape and still rejects `latest` and
any unpinned ref.

Two genuine parser defects surfaced while fixing that, both in the test itself:

1. `curl\s+-fsSL?\s+(\S+)` captured the literal `-O` from `curl -fsSL -O <url>`,
   so the release-asset command never produced a URL.
2. The first token-walk replacement `break`ed at the URL, losing the trailing
   `-o <dest>` and failing three `-o destination` assertions.

Both are gone: one token walk reads `-o` from the stream, accepts only `http(s)`
URLs, and pin-asserts repo artifacts only -- a documented localhost health check
(`http://127.0.0.1:8080/api/health`) is not a versioned artifact.

### Verified

| Gate | Result |
| --- | --- |
| `test-documented-install-command.ts` | `34 passed, 0 failed` |
| `test-release-docs.ts` | contract clean, both languages agree |
| `version:check` / `lint` / `typecheck` | clean, lint `0 errors` (28 warnings) |
| `test-line-endings.sh` | `80 passed, 0 failed` |
| aggregate the low-RAM gate belongs to | `77/77`, `RESULT: PASS`, `AGG_RC=0` |

Non-vacuity by mutation, each turning the suite red:

- unpinning the tag URL to `master` -> 2 failing assertions
- swapping in a floating `releases/latest/download/...` -> 3 failing assertions
- deleting a documented `-o /tmp/...` continuation line -> the 3 `-o` assertions

### The documented command was executed, not just read

- `curl -fsSL -O <release-asset URL>` -> 36,742 B, digest `a0ac1b65f39c1ad3`,
  identical to what the release serves
- run in the live Ubuntu 24.04 target: `bash -n` clean, `--dry-run` exits `0` and
  resolves `/opt/xistance`, the `v1.2.0` release dir, and the real
  `xistance-panel-v1.2.0-amd64.tar.gz` asset URL
- the raw `README.md` GitHub serves for `master` is byte-identical to the
  committed blob, and all three new links return HTTP 200

Docs only: no archive, manifest, tag, or release asset was touched.

### CI on the docs commits

| Run | Commit | Result |
| --- | --- | --- |
| `37247637080` | `4392ce9` | cancelled - superseded by the evidence push |
| `37247936041` | `33f64d6` | **success**, all four jobs |

Run `37247936041` is the one that counts: `Arm64 payload` success, `Lint ·
Typecheck · Version · Tests` success, `Browser gate` success, `Build + Docker`
success. Its log shows `test-documented-install-command.ts` passing and the
aggregate at `77/77 suites passed` / `RESULT: PASS`.

Also verified for the docs change alone:

- `v1.2.0^{commit}` is still `c2ecab7`; the annotated tag object `8ca8051` did
  not move, and the README inside the tag is still the old one (correct: an
  immutable tag keeps its own bytes)
- the release is still public, non-draft, non-prerelease, 11 assets, and the
  installer asset's `updatedAt` is unchanged
- BOTH installer sources the README now offers were executed in the live
  Ubuntu 24.04 target: the tag copy (36,488 B, pre-TMPDIR) and the release
  asset (36,742 B, TMPDIR-aware) each pass `bash -n` and each `--dry-run`
  exits `0`
- `README_FA.md` is valid UTF-8, LF-only, and structurally parallel to the
  English (every new section present in both)

## 2026-10-05 — `--port` bug (user report), release workflow repair, v1.2.3 published

### The reported failure
`curl -fsSL <bootstrap.sh> -o /tmp/xp-install.sh && sudo bash /tmp/xp-install.sh --release --version v1.2.0 --port 8085 --admin-email ...`
died with `Unknown option: --port`.

Root cause, three layers:
1. `release-install.sh` never parsed `--port`, `--admin-email`, `--admin-password`,
   although `bootstrap.sh`'s own header and `README.md` advertise them for release
   installs. All three values already existed downstream — this was pure wiring.
2. The deeper defect: the env-file template hardcoded `PORT=8080` and nothing ever
   overwrote it. `PANEL_PORT` was only read back for the health check, so a release
   install could not listen on any port but 8080 — and the `XT_PORT` escape hatch
   silently did nothing.
3. Documenting `--port` in the usage text introduced `XT_PORT: unbound variable`
   under `set -u`: that heredoc is unquoted by design. Fixed to reference the
   already-defaulted `$PANEL_PORT`.

First attempt placed the validation block above `die()`, so bash printed
`die: command not found` and skipped validation while still exiting 0 on the happy
path. Moved below the function definitions.

### Verified
- Live Ubuntu 24.04 target: installing with `--port 8085` writes `PORT=8085`; with
  `--port 8097` writes `PORT=8097`. v1.2.3 installed over the live paths and serves
  `{"ok":true,...,"version":"1.2.3","database":"ok","engine":"ok"}`.
- Five admin-email/port precedence cases all resolve (flag, `XT_ADMIN_EMAIL`, neither,
  flag-beats-env, `XT_PORT` without unbound-variable).
- `test-release-installer` 62/62 (8 new), including a non-vacuity check that port
  65535 is still accepted so the guard is not blanket-refusing.
- Published v1.2.3 installer runs the exact reported command with `--dry-run` rc=0.

### Release-workflow defects found and fixed (commit `f5a4f40`, `7417405`, `34ff699`, `f165c86`)
1. **Invalid refspec.** `git push origin "tag v1.2.1"` — not a refspec; git rejects
   it. It failed on run `37252340061` *after* the version-bump commit had already
   been pushed, leaving the repo at 1.2.1 with no tag and no release. Now
   `refs/tags/v$(...)`.
2. **ENOSPC misreported as tar.** Run `37254378970` died with
   `tar: Cannot write: Broke` on both architectures. The browser gate
   (`playwright install --with-deps`, ~1.5GB) ran *before* the archive step;
   `ci.yml` had always archived first. Reordered, plus a disk guard that fails with
   `::error::only N MiB free` instead of surfacing inside tar.
3. **Missing mkdir (self-inflicted).** Moving the archive earlier traded one failure
   for another: `Cannot open: No such file or directory`, because nothing else writes
   to `dist/<arch>`. `tar` cannot create the parent directory; `ci.yml` always had
   `mkdir -p`.
4. **Prune destroyed a later input.** My own prune deleted `dist/artifact`, but
   "Verify manifest provenance" runs after the browser gate and copies
   `dist/artifact/release-manifest.json` beside the archive. The prune now preserves
   that file and asserts it survived.

### Two latent stale-version defects in tests
- `test-documented-install-command.ts` hardcoded `const TAG = "v1.2.0"`, so it
  blamed the docs after every bump. Now reads `package.json`.
- `test-embedded-manifest-provenance.ts` built its archive path as
  `xistance-panel-v1.2.0-${arch}.tar.gz` — failing on both architectures on CI
  `37255797986` while the real archive sat next to it. Now reads
  `manifest.artifact.name`.

All four workflow mutations are proven non-vacuous: reverting the refspec, the
ordering, the mkdir, and the manifest preservation each fail with their own
assertion message.

### v1.2.3 publication
Published on the already-pushed `v1.2.3` tag (commit `d6fec72`), 11 assets, public,
non-draft, non-prerelease. amd64 built locally; arm64 taken from the native
`ubuntu-24.04-arm` runner (run `37255797986`), carrying
`libquery_engine-linux-arm64-openssl-3.0.x.so.node`.

Provenance note: the amd64 manifest had to be rebuilt from the **staged** tree
(`dist/artifact`) rather than the build tree, exactly as CI does — otherwise it
declares digest `486fdf54` while the archive extracts to `7646abd5`, and
`test-embedded-manifest-provenance` correctly refuses.

One staging mistake caught by verification: the first `release-install.sh.sha256`
recorded the path `dist/release-install.sh`, so `sha256sum -c` could not find the
file on a fresh download. The digest was correct; only the embedded path was wrong.
Replaced that single asset — all 5 sidecars now verify on a clean download.

Tags `v1.2.2` and `v1.2.3` both exist; `v1.2.2` remains without a release. Neither
the tag nor any asset was mutated to make a check pass.

### Final state verified after the v1.2.3 publication
- CI `37258106669` on `83f3d85`: all four jobs success (Arm64 payload, Lint ·
  Typecheck · Version · Tests, Browser gate, Build + Docker); aggregate
  `77/77 suites passed`, `RESULT: PASS`.
- `HEAD == origin/master == 83f3d85`.
- Release `v1.2.3`: public, non-draft, non-prerelease, 11 assets. Annotated tag
  unchanged at `d6fec72` -- no tag or archive was mutated after publication.
- All 5 published `.sha256` sidecars verify on a clean re-download.
- Live Ubuntu 24.04 target serves `version 1.2.3`, database and engine ok.
- The reported command
  (`--release/--version v1.2.3 --port 8085 --admin-email ...`) runs clean against
  the PUBLISHED installer.

Local gates on the final tree: version:check / typecheck / lint all rc=0;
`test-release-installer` 62/62, `test-cli-regression` 46/46, line-endings 80/80,
`test-embedded-manifest-provenance` 3/3, `test-documented-install-command` 34/34,
`test-release-workflow` 4/4 assertions, `test-release-docs` contract satisfied.

Open item, stated rather than hidden: tag `v1.2.2` exists with no release. It is a
bump commit whose run died before publishing. Deleting it would rewrite published
refs, so it is left in place; `v1.2.3` is the release to install.
