#!/usr/bin/env bash
# Shared immutable release-layout helpers (TASK-10).
#
# Contract:
#   - Every release lives in its own version/digest-derived directory.
#   - A published release directory is never mutated after activation.
#   - Mutable state (data, config, env, logs, tunnel binaries) lives outside
#     the release payload.
#   - An interrupted extraction leaves the active release untouched and removes
#     only the incomplete candidate.
#
# This file is sourced by install.sh / update.sh and is safe to source with
# `set -u` enabled: it defines functions and readonly-ish defaults only.

# Root that owns all versioned release directories, e.g. /opt/xistance
: "${XT_INSTALL_ROOT:=/opt/xistance}"

# Directory holding immutable, versioned releases.
: "${XT_RELEASES_DIR:=${XT_INSTALL_ROOT}/releases}"

# Symlink pointing at the active release.
: "${XT_CURRENT_LINK:=${XT_INSTALL_ROOT}/current}"

# Portable record of the active release, used where symlinks are unavailable.
: "${XT_CURRENT_POINTER:=${XT_INSTALL_ROOT}/current-release.txt}"

# Record of the active and previous release.
: "${XT_ACTIVE_MANIFEST:=${XT_INSTALL_ROOT}/active-release.json}"

# Directory holding per-release state markers (e.g. failed candidates).
: "${XT_RELEASE_STATE_DIR:=${XT_INSTALL_ROOT}/state}"

# Detect the version to use for a release directory name.
# Prefers the release manifest, then the package version, then the git
# description. Returns non-zero only when no version can be determined, which
# makes the caller fall back to the legacy single-directory deploy.
xt_detect_version() {
  local root="${1:-$XT_INSTALL_ROOT}"
  local version=""

  if [[ -f "$root/release-manifest.json" ]]; then
    version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      "$root/release-manifest.json" 2>/dev/null | head -1)"
  fi
  if [[ -z "$version" && -f "$root/package.json" ]]; then
    version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      "$root/package.json" 2>/dev/null | head -1)"
  fi
  [[ -n "$version" ]] || return 1
  printf 'v%s' "$version"
}

# Sanitise a version or digest fragment so it is safe as a single path segment.
# Rejects empty input, path separators, and shell/path metacharacters rather
# than silently normalising them, because a wrong release path is a deployment
# bug, not a formatting issue.
xt_release_slug() {
  local raw="${1:-}"
  [[ -n "$raw" ]] || return 1
  # Allow only [A-Za-z0-9._-]; reject anything else outright.
  if [[ ! "$raw" =~ ^[A-Za-z0-9._-]+$ ]]; then
    return 1
  fi
  # A slug must not be '.' or '..' and must not start with a dot.
  case "$raw" in
    .|..|.*) return 1 ;;
  esac
  printf '%s' "$raw"
}

# Print the immutable release directory name for a version.
# Usage: xt_release_dir_name v1.2.0  ->  v1.2.0
xt_release_dir_name() {
  local version="$1"
  local slug
  slug="$(xt_release_slug "$version")" || return 1
  printf '%s' "$slug"
}

# Assert that a path is safely inside the controlled release root.
# Prints the resolved path on success; returns 1 otherwise.
# This guards every removal so `rm -rf` can never be aimed at a computed path
# outside the install root (TASK-10 technical note).
xt_assert_within_root() {
  local candidate="${1:-}"
  local root="${XT_RELEASES_DIR%/}"
  [[ -n "$candidate" ]] || return 1
  # Reject obvious escapes before any filesystem work.
  case "$candidate" in
    *..*) return 1 ;;
  esac
  case "$candidate" in
    "$root"/*) ;;
    *) return 1 ;;
  esac
  printf '%s' "$candidate"
}

# Create a new, empty, immutable release directory for a version.
# Refuses to reuse or modify an existing directory.
# Usage: xt_create_release_dir v1.2.0  ->  /opt/xistance/releases/v1.2.0
xt_create_release_dir() {
  local version="$1"
  local name target
  name="$(xt_release_dir_name "$version")" || {
    printf 'xt_release_dir_name: invalid release slug: %s\n' "$version" >&2
    return 1
  }
  target="${XT_RELEASES_DIR%/}/${name}"
  if [[ -e "$target" ]]; then
    printf 'release directory already exists and is immutable: %s\n' "$target" >&2
    return 1
  fi
  mkdir -p "$target" || return 1
  printf '%s' "$target"
}

# Remove an incomplete candidate directory, refusing anything outside the root.
# Usage: xt_remove_candidate /opt/xistance/releases/v1.2.0
xt_remove_candidate() {
  local candidate="${1:-}"
  local safe
  safe="$(xt_assert_within_root "$candidate")" || {
    printf 'refusing to remove path outside release root: %s\n' "$candidate" >&2
    return 1
  }
  [[ -d "$safe" ]] || return 0
  rm -rf -- "$safe"
}

# Activate a release directory by atomically repointing the current symlink.
# Records the previous release before switching.
# ---------------------------------------------------------------------------
# xt_rollback — the USER-FACING rollback entry point.
#
# Why this exists: the installer prints "Roll back with: xt_activate_release
# /opt/xistance/releases/<prev>" and both READMEs tell operators to run
# `sudo xt_activate_release ...`. But xt_activate_release is a SHELL FUNCTION
# sourced from this library — nothing installs it into PATH. Executed as
# documented, it is `command not found`, so the documented recovery path for a
# failed upgrade did not work at all.
#
# And the function itself only moves the pointer file and symlink. It contains
# no `systemctl` call, so even when sourced and called correctly, a rollback
# left the OLD process running and serving the OLD code while the panel claimed
# to be rolled back. Observed on Ubuntu 22.04 amd64: after activating v1.1.2,
# /api/health still reported version 1.2.0 and the node process cwd was still
# .../releases/v1.2.0-.../apps/web until the unit was restarted by hand.
#
# This wrapper does what the message promised: activate, restart, and wait.
# ---------------------------------------------------------------------------
xt_rollback() {
  local release_dir="${1:-}"
  # Capture the CURRENT release BEFORE any pointer moves.
  #
  # Reading it after xt_activate_release returns the candidate itself, so the
  # recovery path "restores" the broken release it was rolling back from. Caught
  # by running the first version of this fix against a real broken release: it
  # reported rc=1 correctly, but then printed "restored /opt/xistance/releases/
  # v9.9.9-broken" and left the panel down, because previous == the candidate.
  local previous
  previous="$(xt_current_release || true)"
  if [[ -z "$release_dir" ]]; then
    printf 'usage: xt-rollback <release-dir>\n' >&2
    printf '  e.g. xt-rollback /opt/xistance/releases/v1.1.2\n' >&2
    return 2
  fi

  xt_activate_release "$release_dir" || return 1

  if ! command -v systemctl >/dev/null 2>&1; then
    printf 'systemctl is unavailable; the pointer moved but the service was NOT restarted.\n' >&2
    printf 'Restart it manually or the old process keeps serving the old code.\n' >&2
    return 1
  fi

  # The service may be installed under a different unit name; restart whatever
  # is running, and treat "nothing to restart" as a real failure rather than a
  # silent success, because that is the case where the rollback is a lie.
  local unit
  unit="$(systemctl list-units --type=service --state=running --no-legend 2>/dev/null \
    | awk '{print $1}' | grep -E '^xistance' | head -1)"
  [[ -n "$unit" ]] || unit="xistance.service"

  if ! systemctl restart "$unit"; then
    printf 'failed to restart %s; the pointer moved but the old process is still running.\n' "$unit" >&2
    return 1
  fi

  # A restart that returns 0 is NOT proof the release serves. Proven by
  # execution: activating a release whose server.js exits immediately made
  # systemctl restart succeed, this function print "rolled back ... and
  # restarted", and exit 0 -- while /api/health gave no response at all and the
  # unit sat in "activating". A rollback that leaves the panel DOWN while
  # reporting success is worse than one that refuses: it destroys the working
  # release and then claims it worked.
  #
  # update.sh routes through xt_cutover_with_health_check and restores the
  # previous release on readiness failure. xt_rollback did not, so the same
  # failure was silent here. Probe, and put the previous release back if the
  # candidate never becomes ready.
  local readiness=0

  if command -v xt_wait_for_health >/dev/null 2>&1; then
    if xt_wait_for_health; then
      readiness=1
    fi
  else
    # No probe available (unit tests, non-systemd hosts): fall back to a bounded
    # poll so this still refuses to claim success it cannot see.
    local i code
    for i in $(seq 1 30); do
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
        "${XT_HEALTH_URL:-http://127.0.0.1:${XT_PORT:-8080}/api/health}" 2>/dev/null || true)"
      [[ "$code" == "200" ]] && { readiness=1; break; }
      sleep 1
    done
  fi

  if [[ "$readiness" != "1" ]]; then
    printf 'rolled-back release %s never became healthy; restoring the previous release.\n' "$release_dir" >&2
    if [[ -n "$previous" && -d "$previous" ]]; then
      xt_activate_release "$previous" || true
      systemctl restart "$unit" >/dev/null 2>&1 || true
      printf 'restored %s; the panel is serving the last known-good release.\n' "$previous" >&2
    else
      printf 'no previous release on disk to restore; the panel needs manual attention.\n' >&2
    fi
    return 1
  fi

  printf 'rolled back to %s and restarted %s\n' "$release_dir" "$unit"
}

# Usage: xt_activate_release /opt/xistance/releases/v1.2.0
xt_activate_release() {
  local release_dir="${1:-}"
  local safe previous new_link_tmp
  safe="$(xt_assert_within_root "$release_dir")" || {
    printf 'refusing to activate path outside release root: %s\n' "$release_dir" >&2
    return 1
  }
  [[ -d "$safe" ]] || {
    printf 'cannot activate missing release: %s\n' "$release_dir" >&2
    return 1
  }
  mkdir -p "$(dirname "$XT_CURRENT_LINK")" || return 1
  previous="$(xt_current_release || true)"

  # Activating the release that is ALREADY current must not erase the rollback
  # history. `previous` above is the release being activated in that case, so
  # writing it produces {"active": X, "previous": X} -- a record that names the
  # same release twice, and from which `xt-rollback` can no longer tell where to
  # go back to. The rollback path silently becomes one-way.
  #
  # Observed on a real target: after a drill, re-activating the shipping release
  # left `active == previous`, and the drill could not be reversed again.
  #
  # Keep the RECORDED previous when it is still a real directory, and only fall
  # back to the just-captured value when there is nothing usable recorded. That
  # makes a re-activation a no-op for the record, which is what it is.
  local recorded_previous=""
  if [[ -f "$XT_ACTIVE_MANIFEST" ]]; then
    recorded_previous="$(
      sed -n 's/.*"previous"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        "$XT_ACTIVE_MANIFEST" 2>/dev/null | head -1
    )"
  fi
  if [[ -n "$recorded_previous" && -d "$recorded_previous" && "$recorded_previous" != "$safe" ]]; then
    previous="$recorded_previous"
  elif [[ "$previous" == "$safe" ]]; then
    # Nothing distinct to record. Leave `previous` empty rather than pointing at
    # the active release; the installer populates it on the next real switch.
    previous=""
  fi

  # The pointer file is the authoritative record and is replaced by an atomic
  # rename, so a concurrent reader always sees either the old or the new
  # release and never a partial value.
  printf '%s\n' "$safe" > "${XT_CURRENT_POINTER}.tmp.$$" || return 1
  mv -f -- "${XT_CURRENT_POINTER}.tmp.$$" "$XT_CURRENT_POINTER" || return 1

  # Also repoint the symlink where the filesystem supports one. This is a
  # convenience for humans and for tooling that expects a `current` directory;
  # a filesystem without symlink support must not fail the activation.
  new_link_tmp="${XT_CURRENT_LINK}.new.$$"
  rm -f -- "$new_link_tmp" 2>/dev/null || true
  if ln -sfn "$safe" "$new_link_tmp" 2>/dev/null; then
    # `-T` is GNU-specific and treats the destination as a file, so an existing
    # symlink is replaced rather than being written *into*.
    mv -Tf "$new_link_tmp" "$XT_CURRENT_LINK" 2>/dev/null \
      || mv -f -- "$new_link_tmp" "$XT_CURRENT_LINK" 2>/dev/null \
      || rm -f -- "$new_link_tmp" 2>/dev/null || true
  fi

  xt_write_active_manifest "$safe" "$previous"
}

# Read a field from the active-release manifest without executing it.
# Only `active` and `previous` are readable, and only as raw string values.
_xt_manifest_field() {
  local field="$1"
  local file="$XT_ACTIVE_MANIFEST"
  [[ -f "$file" ]] || return 1
  sed -n "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -1
}

# Print the previous release directory recorded at the last activation.
xt_previous_release() {
  local previous
  previous="$(_xt_manifest_field previous)" || return 1
  [[ -n "$previous" && -d "$previous" ]] || return 1
  printf '%s' "$previous"
}

# Record that a candidate release failed its readiness check.
# The candidate directory itself is retained so the failure can be diagnosed;
# removal is an explicit, separate step.
xt_mark_release_failed() {
  local release_dir="${1:-}"
  local safe name
  safe="$(xt_assert_within_root "$release_dir")" || return 1
  name="$(basename -- "$safe")"
  mkdir -p "$XT_RELEASE_STATE_DIR" || return 1
  printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${XT_RELEASE_STATE_DIR}/failed-${name}"
}

# Activate a release only if it passes a readiness check.
#
# Usage: xt_cutover_with_health_check <release_dir> <ready: true|false>
#
# The readiness result is passed in rather than probed here so the same code
# path can be driven by a real HTTP probe in production and by a deterministic
# double in tests. On failure the pointer is returned to the release that was
# active beforehand and the candidate is marked failed.
xt_cutover_with_health_check() {
  local release_dir="${1:-}"
  local ready="${2:-false}"
  local safe previous
  safe="$(xt_assert_within_root "$release_dir")" || {
    printf 'refusing to cut over to a path outside the release root: %s\n' "$release_dir" >&2
    return 1
  }
  [[ -d "$safe" ]] || {
    printf 'cannot cut over to a missing release: %s\n' "$release_dir" >&2
    return 1
  }

  previous="$(xt_current_release || true)"

  if [[ "$ready" != "true" ]]; then
    # Roll back: if a previous release existed it is still active, so the
    # pointer only needs restoring when this function had already switched it.
    if [[ -n "$previous" && "$(xt_current_release || true)" != "$previous" ]]; then
      xt_write_active_manifest "$previous" "$safe" || true
      printf '%s\n' "$previous" > "${XT_CURRENT_POINTER}.tmp.$$" 2>/dev/null \
        && mv -f -- "${XT_CURRENT_POINTER}.tmp.$$" "$XT_CURRENT_POINTER" 2>/dev/null || true
    fi
    xt_mark_release_failed "$safe" || true
    printf 'readiness check failed for %s; active release unchanged\n' "$safe" >&2
    return 1
  fi

  xt_activate_release "$safe"
}

# Print a human-readable, secret-free status summary of the release layout.
xt_status_report() {
  local active previous
  active="$(xt_current_release || printf '(none)')"
  previous="$(xt_previous_release || printf '(none)')"
  printf 'active:   %s\n' "$active"
  printf 'previous: %s\n' "$previous"
  printf 'releases: %s\n' "$(ls -1 -- "$XT_RELEASES_DIR" 2>/dev/null | tr '\n' ' ')"
}

# Print the currently active release directory, or fail when none is active.
# Uses `readlink` where a real symlink exists (Linux). On filesystems that do not
# create symlinks, it falls back to the pointer file written at activation time,
# so the same contract holds in the MSYS-based test environment.
xt_current_release() {
  if [[ -L "$XT_CURRENT_LINK" ]]; then
    local resolved
    resolved="$(readlink -f -- "$XT_CURRENT_LINK" 2>/dev/null || true)"
    if [[ -n "$resolved" && -d "$resolved" ]]; then
      printf '%s' "$resolved"
      return 0
    fi
    # A symlink that cannot be resolved falls through to the pointer file.
  fi
  if [[ -f "$XT_CURRENT_POINTER" ]]; then
    local pointed
    pointed="$(cat -- "$XT_CURRENT_POINTER" 2>/dev/null || true)"
    if [[ -n "$pointed" && -d "$pointed" ]]; then
      printf '%s' "$pointed"
      return 0
    fi
  fi
  return 1
}

# Write the active/previous release record.
xt_write_active_manifest() {
  local active="${1:-}"
  local previous="${2:-}"
  local dir
  dir="$(dirname "$XT_ACTIVE_MANIFEST")"
  mkdir -p "$dir" || return 1
  # Write via a temp file + move so a reader never sees a partial manifest.
  {
    printf '{\n'
    printf '  "active": "%s",\n' "$active"
    printf '  "previous": "%s"\n' "$previous"
    printf '}\n'
  } > "${XT_ACTIVE_MANIFEST}.tmp.$$" || return 1
  mv -f -- "${XT_ACTIVE_MANIFEST}.tmp.$$" "$XT_ACTIVE_MANIFEST" || return 1
  # The pointer file is the portable record of the active release.
  printf '%s\n' "$active" > "${XT_CURRENT_POINTER}.tmp.$$" || return 1
  mv -f -- "${XT_CURRENT_POINTER}.tmp.$$" "$XT_CURRENT_POINTER"
}
