# TASK-141 — CI went 68/76 to 73/76, and a skip dressed as a pass is gone

Five defects, all found by reading the CI logs rather than trusting a green
local run. Run `37160530198`: **73/76**.

| suite | before | after | cause |
| --- | --- | --- | --- |
| `test-release-assets` | FAIL | ok | required a `TMPDIR` the runner has not got |
| `test-protected-routes` | FAIL | ok | same |
| `test-real-archive-verify` (arm64) | FAIL | ok | no arm64 archive existed on an x64 runner |
| `test-embedded-manifest-provenance` (arm64) | FAIL | ok | same |
| `test-dashboard-legibility` | FAIL | **ok, 157.3s** | playwright resolved only at Windows paths |
| `test-lowram-cgroup-gate` | FAIL | FAIL | needs root cgroups; registered but invoked without its arguments |
| `test-rollback-drill` | FAIL | FAIL | needs `xtinst`/`xt24` |
| `test-target-runs-shipped-payload` | FAIL | FAIL | needs `xtinst`/`xt24` |

## The one that mattered: a skip that reported success

`test-dashboard-legibility` printed

```
--   browser measurement SKIPPED (no playwright resolvable)
```

and then **exited green**. Six suites located playwright only under
`~/AppData/Local/...`, which does not exist on Linux, so resolution returned
null and the legibility, a11y, RTL and auth claims rested on source inspection
alone while CI reported success.

This is the exact failure the aggregate's rule exists to prevent — *"A suite
that cannot run is a FAILURE, not a skip"* — except it was worse than a skip,
because it was reported as a pass.

Installing Chromium in the job did **not** fix it. That step ran and succeeded
on the runner and the suite still found nothing, because it was never looking
where Linux puts playwright:

- `playwright-core` now resolves from the repository's own `node_modules` first,
  then the per-platform npx cache, then the Windows shapes.
- the browser binary is found in `~/.cache/ms-playwright` on Linux,
  `AppData/Local/ms-playwright` on Windows, `Library/Caches` on macOS.

Fixed in `test-dashboard-legibility`, `test-a11y-browser`,
`test-dialog-keyboard`, `test-rtl-browser`, `test-state-a11y`,
`test-smoke-auth`.

**Evidence it is real now:** the suite takes **157.3s in CI instead of 0.4s**,
and no run in the log claims a skip. Locally on Windows, no regression:
648/648 legibility, and 13 + 34 + 33 + 50 + 35 for the other five.

## `TMPDIR` is a convention, not a guarantee

Twelve suites consult it; nine already ended the chain with `os.tmpdir()`.
Three did not, and GitHub's runners set none of `TMPDIR`/`TEMP`/`TMP`, so they
failed there and passed on any developer machine that exports one. Same shape as
the untracked `.env.local` defect in task-138.

## A fabricated SHA, caught before it could break CI

The new `download-artifact` step first carried a 40-character SHA that was
well-formed but did not exist — GitHub 404s the ref and the job would not have
started. Caught by resolving each pinned SHA against github.com; all four pins
in the workflow now verifiably resolve.

## Still red, and honestly so

1. **`test-rollback-drill`, `test-target-runs-shipped-payload`** — need
   `xtinst`/`xt24`, which are local containers. This is the CI-structure
   decision that was cancelled and never answered.
2. **`test-lowram-cgroup-gate`** — registered in the aggregate but invoked with
   no arguments, so it died on its own usage line. Its comment claimed it was
   "NOT run by this file" while the next line registered it; both cannot be
   true. It is now invoked with the staged artifact root and server dir and
   proceeds past the usage message.

**Not verified:** the privileged cgroup invocation. The command to run it on the
target was blocked and not retried, so the gate's Linux behaviour is unchanged
and still untested from CI. That gap is stated rather than papered over.

## Arm64

The arm64 job is green on every run since `37156870877`: built on native
aarch64, inspected, archived, checksummed, digest-verified, installed
fail-closed, uploaded — 17/17 steps.