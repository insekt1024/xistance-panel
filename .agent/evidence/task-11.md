# TASK-11 evidence — atomic active-release cutover

**Status:** passed (local verification; no live VPS cutover yet — see gaps)

## Changes

| File | Change |
| --- | --- |
| `scripts/lib/release-layout.sh` | Added `xt_cutover_with_health_check`, `xt_previous_release`, `xt_mark_release_failed`, `xt_status_report`, `_xt_manifest_field`, and `XT_RELEASE_STATE_DIR`. |
| `scripts/test-release-cutover.sh` | New focused bash test (19 assertions) driving the real library. |
| `scripts/install.sh` | `install_systemd` now resolves `WorkingDirectory`/`ExecStart` through the active release pointer; `show_status` prints the release layout. |
| `scripts/update.sh` | Rewritten deploy: build candidate → activate → restart → real health probe → roll back on failure. |

## Cutover contract

```
xt_cutover_with_health_check <release_dir> <ready:true|false>
```

- Rejects any path outside the releases root (traversal included).
- On `ready=false`: the active pointer is left on the previous release, the
  candidate is marked failed via `state/failed-<name>`, and the function
  returns non-zero.
- On `ready=true`: the pointer is switched atomically and the previous release
  is recorded in `active-release.json`.

The readiness result is a parameter rather than a probe *inside* the function so
the identical code path can be driven by a real HTTP health check in production
and by a deterministic double in tests. `update.sh` supplies the real probe.

## Acceptance criteria → evidence

1. **Active release changes through an atomic cutover, not an in-place overwrite.**
   `xt_activate_release` writes the pointer file to a temp path and renames it
   over the target, so a reader sees either the old or the new release.
   Covered by "cutover switches the active pointer to the new release",
   "cutover does not modify the previous release directory", "previous release
   remains a separate directory".
2. **Service resolves the active release at startup with the same env/data paths.**
   The unit now uses `WorkingDirectory=/opt/xistance/current` and
   `ExecStart=/usr/bin/env node /opt/xistance/current/apps/web/.../server.js`,
   with the unchanged `EnvironmentFile`. A fallback resolves the concrete
   release directory on a first install, so the unit is never dangling.
3. **Failed readiness check returns the pointer to the previous release.**
   Covered by "cutover reports failure when readiness fails", "failed readiness
   returns the pointer to the previous release", "failed candidate is recorded
   as failed", "failed candidate directory is retained for diagnosis".
4. **Previous release available and identified in status output.**
   `xt_status_report` prints `active`, `previous`, and the release list;
   `show_status` renders it. Covered by "previous release is reported from the
   manifest", "status output names the active release", "status output names the
   previous release".

## Secret hygiene in status output

`xt_status_report` prints paths only. The test asserts the output contains none
of `JWT_SECRET`, `password`, `token`, `secret` — four dedicated assertions.

## Test results

```
scripts/test-release-cutover.sh   19 passed, 0 failed
scripts/test-release-layout.sh   35 passed, 0 failed   (no regression)
```

## Verification commands and results

| Check | Result |
| --- | --- |
| `bash scripts/test-release-cutover.sh` | `19 passed, 0 failed` |
| `bash scripts/test-release-layout.sh` | `35 passed, 0 failed` |
| `bash -n` on all 8 shell scripts | all ok |
| `npm run version:check` | `✓ All 7 version files match 1.1.2` |
| `npm run lint` | pass (known pages-dir notice only) |
| `npm run typecheck` | exit 0 |
| `scripts/test-optimizations.ts` | `Results: 77 passed, 0 failed of 77` |

## Bugs found and fixed during this task

1. **`XT_RELEASES_DIR` was read before it was exported** in my first
   `update.sh` rewrite, so the "already exists" collision check would have run
   against the library default `/opt/xistance/releases` rather than the actual
   install. Reordered so the exports come first.
2. **A `STAGE_DIR` was created and never used** in the same patch. Removed
   rather than left as dead code.

## Recorded gaps (not proven by this task)

1. **No live cutover on a real host.** The health probe loop, `systemctl
   restart`, and the real rollback path in `update.sh` have never executed on
   Linux with systemd. The rollback *logic* is unit-tested with a double, not
   end-to-end.
2. **The `current` symlink still is not exercised on a real filesystem.** As in
   TASK-10, tests run under MSYS where symlinks are not created. On Linux the
   pointer file remains authoritative, so the contract holds either way, but
   the symlink branch is unverified.
3. **No release-retention policy.** Failed and superseded releases accumulate
   under `releases/`. Cleanup is an explicit step that does not yet exist; this
   will matter on a 1 vCPU / low-disk host.
4. **`update.sh` still rebuilds from source on the server** (`npm ci` +
   `npm run build`), which contradicts the zero-build goal. The immutable
   cutover is now correct, but the *artifact* consumed is still a source build.
   TASK-13 (one-line installer) is what removes this.
5. **Health probe is unauthenticated `/api/health` only.** It proves the process
   is serving, not that tunnels work.

## Secret handling

No credential, token, or private key was written into the library, tests,
installer, updater, or this evidence file. VPS values remain `[REDACTED]`.
