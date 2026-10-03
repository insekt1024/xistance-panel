# TASK-64 — update / migration / forced failure / rollback: EXECUTED on Ubuntu 22.04 amd64

Status: **verified on the real target OS.** Two real defects in the recovery path
were found by executing it, and fixed. Full detail, including the mutation
proof, in `task-64-update-rollback-executed.md`.

## What was run

| step | result |
|---|---|
| install v1.1.2 (creates a rollback target) | exit 0, healthy, previous retained |
| controlled update v1.1.2 → v1.2.0 | exit 0, timestamped release dir, `migrations up to date` |
| forced failure, corrupt archive, valid tag | exit 6, refused, **live install untouched** |
| forced failure, tampered sidecar | exit 6, `Checksum verification FAILED … Not extracting` |
| negative control, correct sidecar | exit 0, verified + healthy |
| rollback via the installed command | pointer, process cwd, **and** reported version all reverted |

## Two defects found and fixed

1. **The documented rollback command did not exist.** The installer printed
   `Roll back with: xt_activate_release …` and both READMEs said
   `sudo xt_activate_release …`, but that is a shell function sourced from
   `lib/release-layout.sh`. On the target: `command not found`, and
   `find / -name xt_activate_release` returned nothing.

2. **Rollback did not take effect even when called correctly.**
   `xt_activate_release` contains no `systemctl` call — it moves the pointer and
   symlink only. After activating v1.1.2 the pointer said v1.1.2 while the
   process cwd was still `…/v1.2.0-…/apps/web` and `/api/health` still
   reported `1.2.0`. A rollback that reports success and changes nothing.

Fixed with `xt_rollback` (activate + restart + fail loudly), installed as
`/usr/local/bin/xt-rollback` by `xt_install_rollback_command`, and both READMEs
and the installer hint now name the real command.

## Regression coverage

- `scripts/test-release-installer.sh` — 6 new checks, 47/47. Three mutants
  killed: README reverted to the function, `systemctl restart` removed from the
  wrapper, installer hint reverted.
- `scripts/test-readme-fa-parity.ts` — keyword updated from the removed
  function name to `xt-rollback`; 66/66, mutant killed.
- `npx tsx scripts/run-all-tests.ts` — **50/50, exit 0**.
- version-check, typecheck, lint (0 errors / 24 warnings), audit (0
  vulnerabilities), release-docs — all exit 0.

---

# TASK-72 — final release gate decision (v5, current)

Supersedes v1–v4. **v4's premise was wrong and is retracted**: it said the
release target required a VPS credential. Docker was installed on the build
machine the whole time, and Ubuntu 22.04/24.04 amd64 with systemd as PID 1 run
locally in privileged containers. See `target-os-docker-available.md`.

## Decision: **NO-GO for publishing 1.2.0** — TASK-63 and TASK-65 remain.

TASK-62 and TASK-64 are now executed and verified on real Ubuntu 22.04 amd64.
TASK-63 and TASK-65 are not yet executed. Everything else is green.

## Task status

| task | status |
|---|---|
| TASK-62 installer E2E, 22.04 | **executed, passed** |
| TASK-64 update / migration / forced failure / rollback | **executed, passed** (2 real defects found and fixed) |
| TASK-63 startup, health, static assets, low-resource on **24.04** | partial — verified on 22.04; the 24.04 container run is outstanding |
| TASK-65 tunnel load and reconnect | not started |
| other 69 tasks | verified |

## Gate state, 2026-09-30

- `npx tsx scripts/run-all-tests.ts` — **50/50, exit 0**
- version-check, typecheck, lint (**0 errors / 24 warnings**), audit (**0
  vulnerabilities**), release-docs, installer (**47/47**), Persian parity
  (**66/66**) — all exit 0
- **Browser gate 12/12, 597/597, 0 skipped, artifact exercised** (`gate-munlpa5w`,
  staged manifest `1.2.0`)
- Release archive built with CI's exact commands and verified by
  `release-manifest.ts verify` → **PASS**

## Ordering for whoever resumes

1. Run the TASK-63 install on the Ubuntu 24.04 container (image `xt-target:24.04`
   is built and working; `xtrel`/`xt24` recipe is in the evidence).
2. Run TASK-65 tunnel load/reconnect on the target.
3. Re-run the browser gate if `apps/` changed.
4. Only then: commit, tag `v1.2.0`, push.

No commit, tag, push, or GitHub release has been made. The dirty worktree is
intact and was never reset. All target connection values are [REDACTED].

---

# TASK-72 — final release gate decision (v4, RETRACTED — wrong premise)

> **Retracted.** This version claimed the release target was unreachable without
> a VPS credential. That was wrong: Docker was available locally and
> 22.04/24.04 amd64 with systemd run in privileged containers. TASK-62 and
> TASK-64 have since been executed and verified. Retained below only to record
> the correction.

# TASK-72 — final release gate decision (v4)

Supersedes v1, v2, and v3. v3 predates the aggregate test runner, the WSL
execution of the two Linux suites, and the retry-bounds timing fix.

## Decision: **NO-GO for publishing 1.2.0.** Everything local is green.

The only remaining blocker is TASK-62–65, which need a target VPS credential.
Everything else in the ledger has now been executed.

## What changed since v3

Two suites that had been reported blocked for the whole release turned out not
to be. The distinction that had been collapsed is **target host vs target
platform**: TASK-62–65 need a disposable VPS with credentials and systemd;
TASK-16 and TASK-61 only needed *Linux*, and WSL provides it.

| | before | now |
|---|---|---|
| suites passing | 48/49 (one platform-blocked) | **50/50** |
| `test-protected-routes.ts` (TASK-16) | n/a — needs Linux | **ok**, staged payload serves every asset |
| `test-lowram-cgroup-gate.sh` (TASK-61) | n/a — needs Linux | **ok**, 80 MiB peak under a 256 MiB cgroup cap |

The cgroup gate was also proven non-vacuous: at a 48 MiB cap it produces a real
`oom_kill 1` and correctly FAILS. And three genuine defects were fixed along the
way — a stale fixture in the cgroup gate, a timing flake in `test-retry-bounds`
(1/8 pass under load → 8/8 after a bounded poll), and a workflow test asserting
against the wrong upload step.

## Gate state, 2026-09-30

- **`npx tsx scripts/run-all-tests.ts` → 50/50, exit 0** (266s), including both
  Linux suites under WSL.
- version-check, typecheck, lint (**0 errors / 24 warnings**), audit (**0
  vulnerabilities**) — all exit 0.
- **Browser gate: 12/12 suites, 597/597 assertions, 0 skipped, artifact payload
  exercised** — verdict `gate-munlpa5w`, staged manifest `1.2.0`.
- CI now runs the same 50-suite list (`Full local test suite` step) and fails if
  any `test-*` on disk is unregistered.

## Ordering for whoever resumes

1. Obtain the target VPS credential (TASK-62–65).
2. `npm run build` with `TURBO_DISABLE=true`
3. `npx tsx scripts/stage-release-artifact.ts . dist/artifact --architecture amd64`
4. Confirm `dist/artifact/release-manifest.json` reads `1.2.0` before trusting any
   browser result — staging copies that file, it does not generate it.
5. Only then: commit, tag `v1.2.0`, push.

No commit, tag, push, or GitHub release has been made. The dirty worktree is
intact and was never reset. All target connection values are [REDACTED].

---

# TASK-72 — final release gate decision (v3, superseded)

Supersedes v1 and v2. v2 predates the Xray digest pin, the 1.2.0 version
cutover, and the release-manifest fix. **This record supersedes both** and is
the one to read.

## Decision: **NO-GO for publishing 1.2.0.** Local gates are green.

Two independent blockers, either sufficient alone:

1. **TASK-62–65 blocked** on a target-host credential. Windows evidence cannot
   substitute for Ubuntu 22.04/24.04 evidence.
2. **`v1.2.0` does not exist as a ref.** The tree is labelled 1.2.0 and both
   READMEs agree with it, but no commit, tag, or push has been made, so the
   documented raw install URL still returns 404. Consistency is not publication.

The distinction matters: nothing is *wrong* with the 1.2.0 tree. It is correct
and unproven on the target platform, and therefore not shippable.

## Local gate, 2026-09-30 — 15/15 exit 0

version-check, typecheck, lint (**0 errors / 23 warnings**), release docs,
Persian parity 62/62, installer 41/41, supply-chain 55/55, line-endings, SSH
injection 37/37, SSRF 116/116, XUI, optimizations, method-matrix,
auth-security, audit (**0 vulnerabilities**).

**Browser gate: 12/12 suites, 597/597 assertions, 0 skipped, artifact payload
exercised: yes** — verdict `gate-munimvr3`, against a staged manifest reading
`1.2.0` / `v1.2.0` / `xistance-panel-v1.2.0-amd64.tar.gz`.

Provenance verified by mtime, not assumed:

```
version.ts (1.2.0)    06:16:29
release-manifest.json 06:23:48   <- regenerated at the new version
staged manifest       06:23:48   <- matches
staged server.js      06:19:12
gate verdict          06:35:01   <- downstream of all of the above
```

## Two stale green results, explicitly demoted

- `gate-munibkau` reported 12/12 / 597 PASS against a staged manifest still
  reading **1.1.2**. Correct verdict, wrong artifact — 33 minutes old. Kept as a
  cautionary record; a PASS is only as current as the payload beneath it.
- A 13-check sweep run before the cutover passed 13/13 while the tree was 1.1.2
  and the docs already said `v1.2.0`. Superseded.

## Ordering constraint for whoever resumes

1. Obtain the target-host credential (TASK-62–65).
2. `TURBO_DISABLE=true npm run build`
3. `npx tsx scripts/stage-release-artifact.ts . dist/artifact --architecture amd64`
4. Read `dist/artifact/release-manifest.json` and confirm `1.2.0` **before**
   trusting any browser result — staging copies that file rather than
   generating it, so a leftover copy silently ships the previous version.
5. Only then: commit, tag `v1.2.0`, push.

No commit, tag, push, or GitHub release has been made. The dirty worktree is
intact and was never reset. TARGET-1 values are [REDACTED].

---

# TASK-72 — final release gate decision (v2, superseded)

## Decision: **NO-GO for 1.2.0.** Blocked on target-host credentials, which
## are not present in this session — and the earlier "local work is complete"
## claim was wrong.

This supersedes [task-72-final-gate-decision.md](task-72-final-gate-decision.md).

The v1 file said everything verifiable on this machine had been verified. An
independent security review delivered *after* that statement reported a
**critical SSH argument-injection RCE**. I reproduced it before changing
anything: the local OpenSSH executed a `-oProxyCommand=` payload delivered
through a `username` field, on this host. So the v1 assessment was premature,
and it is recorded here rather than quietly replaced.

## What changed since v1

**Fixed — critical.** `NodeConfigSchema` accepted a `username` beginning with
`-`; both argv construction sites turned it into an SSH *option*, so
`-oProxyCommand=touch /tmp/marker` ran on the panel host. Three layers: schema
+ both sinks, each with its own mutant (37/37, 3/3 killed). Full reproduction
and analysis: [task-66-ssh-destination-injection.md](task-66-ssh-destination-injection.md).

**Fixed — medium.** X-UI panel probe now refuses loopback / link-local /
unspecified / broadcast while keeping private and tailnet access, which the
feature legitimately needs.

**Fixed — low.** Node credential ciphertext (`sshKeyEncrypted`,
`sshPasswordEnc`, `apiTokenEncrypted`) removed from the API backup JSON export;
raw `ssh` stderr now runs through `sanitizeForDiagnostics` before logging.

**Fixed — a real product-independent test defect.** The browser gate failed
11/12 on `node row menu returns focus to the trigger`, reproducible 2 runs in
3. The assertion read `document.activeElement` once with no settle while Radix
returns focus after the close animation. Now polls; six consecutive clean runs;
a rebuilt `onCloseAutoFocus` mutant fails 2/2 in both locales.

**Corrected — two assertions, not the code.** `test-ssrf-guard.ts` and
`test-xui.ts` matched the literal comment string `intentionally no SSRF`. The
security comment was rewritten to explain a *narrower* policy, and both failed
while the behaviour improved. Both now match on intent and additionally assert
the narrower policy is actually applied — stronger than before, not merely
looser.

## Local gate — all green, re-run after the fixes

| check | result |
|---|---|
| `npm run version:check` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 — **0 errors**, 24 warnings |
| `npm audit --audit-level=high` | exit 0, 0 vulnerabilities |
| `TURBO_DISABLE=true npm run build` | exit 0 |
| staging (`--architecture amd64`) | exit 0 |
| **browser gate** | **12/12 suites, 597/597 assertions, 0 skipped, artifact covered** |
| installer suite | 41/41 |
| SSRF guard | 116/116 |
| SSH destination injection | 37/37 (3/3 mutants killed) |
| XUI | 50/50 |
| optimizations / method-matrix / backhaul / auth-security | exit 0 |
| release docs / Persian parity | exit 0 / 62/62 |

Per-suite browser breakdown: `artifact-assets` 23, `a11y-baseline` 59,
`a11y-contrast` 72, `dialog-keyboard` 34, `state-a11y` 50,
`smoke-nodes-tunnels` 24, `smoke-tunnel-diagnostics` 69, `smoke-routes` 80,
`smoke-auth` 35, `smoke-fa` 105, `rtl-browser` 33, `a11y-browser` 13.

The artifact suite was run against a **freshly staged** payload. My first
staging attempt omitted `--architecture amd64` and exited 2, so the earlier
11/12 result was measured against a stale artifact; the corrected sequence is
staged, then gated.

## A methodological finding that limits some of the above

`next start` serves a prebuilt `.next`, so a suite tagged `source` cannot test a
source change without rebuilding. A mutation over a rendered component that
skips the rebuild **survives vacuously** — indistinguishable from a vacuous
assertion, and it invites "fixing" a correct test. Any such proof must be
mutate → **rebuild** → run → restore → **rebuild** → run.

This bit me directly: `<DropdownMenu onOpenChange={() => {}}>` "survived" twice
and I initially attributed it to a stale build. After rebuilding it still
survived — Radix keeps its own state, so that mutant was semantically inert.
The real kill switch (`onCloseAutoFocus` → `preventDefault`) failed 2/2.

Detail: [browser-source-mutants-need-rebuild.md](browser-source-mutants-need-rebuild.md).

**Not re-audited:** I have not checked every browser suite for this property.
The mutation proofs that mutated files the tests read directly from disk
(`release-install.sh`, `ssrf.ts`, `forward-host.ts`, `types/index.ts`) were
genuinely executed. The rendered-component proofs are the ones that needed the
rebuild discipline, and I applied it to the one I ran.

## What the local gate does NOT establish

- **No target-host evidence whatsoever.** Every row above is Windows/MSYS.
- TASK-62 (Ubuntu 22.04 install E2E), TASK-63 (24.04 startup + health + static
  assets), TASK-64 (update / migration / rollback), TASK-65 (tunnel load +
  reconnect) are **unproven and not waived**. The installer suite asserts
  source and behaviour shape; it installs no systemd unit and runs no release
  on Ubuntu.
- **The blocker is credentials, not the host.** `TASK-1.json` records a real
  Ubuntu 24.04 VPS supplied and verified on 2026-09-25, and that host's SSH
  port still answers a TCP probe — but the host is absent from
  `~/.ssh/known_hosts` and no key for it exists in this session. Port
  reachability is not access. Detail: [task-62-65-vps-blocked.md](task-62-65-vps-blocked.md).
- **No sustained-load resource numbers.** Windows shutdown / leak / telemetry
  tests say nothing about 2 GB under sustained traffic.
- **No Xray provenance pin.** FRP / GOST / Naive are pinned and checksummed;
  Xray is not.
- **The browser result is staged-artifact-on-Windows**, not target evidence.
- **Version not cut over.** Docs target 1.2.0; `package.json` and
  `apps/web/src/lib/version.ts` are still 1.1.2. Deliberate: the bump labels a
  release, so it goes last, after every gate passes on the code it will name.
- **No commit, no tag.** The worktree is dirty by design.

## To flip this to GO

1. Provide an Ubuntu 22.04 amd64 host with root SSH → run TASK-62.
2. Provide an Ubuntu 24.04 amd64 host → run TASK-63, TASK-64, TASK-65.
3. Re-run the full local gate on the result.
4. Bump `package.json` + `apps/web/src/lib/version.ts` to 1.2.0, re-run
   `version:check` and the docs/parity suites.
5. Commit, tag, publish.

Steps 1–2 are external. Nothing in this repository can substitute for them, and
I am not going to mark them passed on local evidence.
