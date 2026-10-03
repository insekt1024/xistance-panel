# TASK-10 evidence — immutable versioned deployment directories

**Status:** passed (local verification; no live VPS deploy yet — see gaps)

## Changes

| File | Change |
| --- | --- |
| `scripts/lib/release-layout.sh` | New sourced library: slug sanitisation, release-dir creation, root-confined removal, atomic activation, active/previous manifest, version detection. |
| `scripts/test-release-layout.sh` | New focused bash test (35 assertions) driving the real library. |
| `scripts/install.sh` | `deploy_panel` now deploys into a version-derived candidate directory and activates it only after the payload is complete; legacy single-directory behaviour is kept as an explicit fallback. |

## Deployment layout

```
/opt/xistance/
  releases/
    v1.2.0/            <- immutable, never overwritten
    v1.3.0/
  current              <- symlink (Linux), convenience only
  current-release.txt  <- authoritative pointer, atomic rename
  active-release.json  <- { "active": ..., "previous": ... }
/var/lib/xistance/     <- data, logs, tunnel binaries (outside the release)
/etc/xistance/         <- env file (outside the release)
```

## Acceptance criteria → evidence

1. **Unique version/digest-derived directory, not overwritten after activation.**
   Covered by "creates a versioned release directory", "refuses to overwrite an
   existing release", "a new version gets a distinct directory",
   "rejects an unsafe version segment", "creates no directory for a rejected
   version". `xt_create_release_dir` fails if the target already exists, so a
   published release cannot be modified in place.
2. **Mutable data/config/logs/keys/binaries outside the immutable release.**
   `DATA_DIR` (`/var/lib/xistance`) and `ETC_DIR` (`/etc/xistance`) are created
   separately and are never written into the candidate directory; the deploy
   tar excludes `.git`, `.next`, `tunnels`, `*.db`, `*.db-journal`. Covered by
   "release payload holds no mutable data/config/bin directories" and
   "release directories are nested under the releases root".
3. **Manifest identifies active and previous release.**
   `xt_write_active_manifest` writes `active` and `previous` via temp-file +
   `mv`. Covered by "active manifest names the active release", "active
   manifest records the previous release", "previous release directory is
   retained".
4. **Interrupted extraction leaves the active release untouched.**
   Activation happens only after extraction and the build-output copy succeed.
   Covered by "incomplete candidate is removed", "active release is untouched
   by candidate cleanup", "active release survives refused removals".

## Test result

```
=== TASK-10: immutable versioned deployment directories ===
...
--- 35 passed, 0 failed ---
```

The test executes the shipped shell functions directly (it sources
`scripts/lib/release-layout.sh`), so a pass means the real installer code
behaves correctly, not a re-implementation.

## Safety: no `rm -rf` against an unvalidated computed path

`xt_remove_candidate` and `xt_activate_release` both route through
`xt_assert_within_root`, which rejects any path containing `..` and any path
not under `$XT_RELEASES_DIR`. Verified by:

- "refuses to remove a path outside the release root" (`$XT_TEST_ROOT/../escape`)
- "refuses to remove an absolute system path" (`/etc`)
- "refuses to activate a path outside the release root" (`/tmp`)

`install.sh`'s candidate cleanup also reuses the validated path rather than
recomputing it.

## Bugs found and fixed during this task

1. **`SCRIPT_DIR` was undefined in `install.sh`.** My first integration referenced
   `$SCRIPT_DIR/lib/release-layout.sh`; the script only defines `REPO_ROOT`, so
   the library would have been silently *not* sourced and the versioned path
   never taken. Fixed to `$REPO_ROOT/scripts/lib/release-layout.sh`.
2. **`xt_detect_version` did not exist** when first referenced. Implemented and
   covered by three dedicated assertions.
3. **`xt_current_release` was Linux-only.** It used `readlink -f` on the symlink,
   which returns empty in the MSYS test environment, so 7 assertions failed for
   an environmental reason rather than a real defect. Resolved by making the
   pointer file authoritative and the symlink a convenience, which also makes
   activation work on filesystems without symlink support.
4. **Activation did not switch on re-activation.** `mv -Tf` is not emulated by
   MSYS, so the second activation silently left the old release active. Fixed by
   writing the pointer file with an atomic rename *before* the best-effort
   symlink update, so the switch no longer depends on symlink semantics.
5. **Test-harness bug (not product code).** `new_root` originally ran in a
   `$(...)` subshell, so its `export`s never reached the caller and tests ran
   against the real default `/opt/xistance`. Fixed to assign to a global instead
   of echoing, and the two remaining `$root` references were repointed.

## Verification commands and results

| Check | Result |
| --- | --- |
| `bash scripts/test-release-layout.sh` | `35 passed, 0 failed` |
| `bash -n` on all 7 shell scripts | all ok |
| `npm run version:check` | `✓ All 7 version files match 1.1.2` |
| `npm run lint` | pass (known pages-dir notice only) |
| `npm run typecheck` | pass |
| `scripts/test-optimizations.ts` | `Results: 77 passed, 0 failed of 77` |

## Recorded gaps (not proven by this task)

1. **No live VPS deployment was run.** The layout is verified in a sandbox
   install root under MSYS, not on a real Linux host with systemd. The
   `current` symlink path in particular only exercises on a real filesystem.
2. **`update.sh` still uses the old single-directory flow** (`tar -C "$INSTALL_DIR"`).
   It was not modified in this task, so an update does not yet create a new
   versioned release. This must be wired before the immutable-update and
   rollback criteria of TASK-14 can pass.
3. **The source-mode fallback in `deploy_panel` still writes into `$INSTALL_DIR`**
   when no version can be detected. This preserves existing bootstrap behaviour
   but is not the immutable layout; it needs a real version source.
4. **No digest-derived directory naming yet.** Directories are version-derived
   only; the task title also allows a digest, which is not implemented.

## Secret handling

No credential, token, or private key was written into the library, the test, the
installer, or this evidence file. VPS values remain `[REDACTED]`.
