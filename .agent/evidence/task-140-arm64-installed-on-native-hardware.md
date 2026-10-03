# TASK-140 — arm64 BUILT and INSTALLED on native aarch64 hardware

Closes TASK-119. The arm64 artifact is no longer merely buildable; it is built,
verified and installed by a real arm64 machine, and the installed release
answers `/api/health`.

Run `37156870877`, job **"Arm64 payload (native runner)" — 17/17 steps success**:

| step | result |
| --- | --- |
| Report runner architecture (`uname -m` = aarch64) | success |
| Build packages (**native Prisma engine on aarch64**) | success |
| Build standalone output | success |
| Seed / build / inspect the arm64 manifest | success |
| Stage the arm64 artifact | success |
| Archive + checksum | success |
| Verify the embedded digest describes the archive | success |
| Confirm the payload carries an arm64 query engine | success |
| **Install the arm64 archive (fail closed)** | success |
| Upload the arm64 payload | success |

## The install gate found a real, architecture-independent defect

Getting the install to run on arm64 is what finally exposed this. Three
successive failures, each needing its own diagnosis:

**1. `Invalid version '1.2.0'.`** The installer's guard is
`^v[0-9]+\.[0-9]+\.[0-9]+$`; it exits 2 before extracting. I had passed
`package.json`'s bare version. `release.yml` was already correct.

**2. The installer reported no cause at all.** It said only
`Readiness check failed; rolling back.` On failure it now dumps
`systemctl status`, `journalctl`, what PID 1 is, and the release dir.

**3. `status=200/CHDIR` — and it was never about arm64.**

```
Changing to the requested working directory failed: Permission denied
Main process exited, code=exited, status=200/CHDIR
```

The unit runs as `xistance` with `WorkingDirectory=/opt/xistance/current`, a
symlink into the release tree. Diagnostics resolved the link:

```
current -> /opt/xistance/releases/v1.2.0
  resolved target mode=700  owner=runner:runner
  DENIED  resolved release dir   <- this is the cause
```

The release tree inherits the caller's umask. **GitHub runners use `077`**, so
the release landed `0700` owned by `runner`, and the service could not enter its
own working directory.

**The amd64 targets never saw this because a normal admin shell has umask
`022`, which lands `0755`.** They were passing by accident. The installer is
invoked from sudo, CI, cron and one-line pipes — each with its own umask — so
this was never stable.

Reproduced and verified on a target before fixing: a directory created under
`umask 077` is `700` and the service user is `DENIED`; after
`find -type d -exec chmod 0755` it is `755` and the user enters it.

The fix pins the mode rather than inheriting it: every release directory
traversable, nothing world-writable. The tree stays root-owned, so the panel
still cannot modify its own code.

### Guesses I disproved before finding it

Recorded because the wrong turns cost the most time here:

- **release directory modes** — all 415 archived directories are `0755`, and a
  non-root user *can* chdir into a `0755` root-owned tree.
- **the path components** — `/`, `/opt`, `/opt/xistance` all `0755` and
  traversable by `xistance`.
- **the hardening directives** — a probe unit with the same `WorkingDirectory`,
  `User`, `ProtectSystem=full` and `ProtectHome=true` starts successfully.
- **a speculative `chmod 0755` fix I wrote and then reverted**, because it would
  have claimed to fix something I had just disproved. A fix that changes
  nothing is worse than no fix.

I also had to fix my own diagnostic twice: it first matched a prose comment
containing the literal text `--version must be ...`, and then captured only
`"$(node` from a substitution containing spaces — so it *passed* on the exact
defect it was written for. Both were caught by mutating `ci.yml` back to the
bare version and watching the gate fail.

## A regression I caused and corrected

Reproducing the digest check locally wrote an **amd64 archive into
`dist/arm64/`** — an architecture-mislabelled artifact. Four suites correctly
failed on it (`72/76`). The genuine arm64 archive from run `37151742784` now
occupies that directory, checksum verified, and the four suites are green again.

## Still open

- **CI has no `xtinst`/`xt24`**, so `test-rollback-drill` and
  `test-target-runs-shipped-payload` still need local targets. See
  `task-138-first-live-ci-run-found-six-defects.md`.
- **No release tag exists.** The release workflow itself has still never run.