#!/usr/bin/env bash
# Focused tests for the immutable release layout (TASK-10).
#
# Runs the real functions from scripts/lib/release-layout.sh against a
# temporary install root, so a passing result means the shipped shell code
# behaves correctly, not a re-implementation of it.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${SCRIPT_DIR}/lib/release-layout.sh"

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; [[ $# -gt 1 ]] && printf '      %s\n' "$2"; }

# Point the layout library at a fresh sandbox install root for one test case.
# This must not run in a subshell: the exports have to survive into the caller
# so the sourced library and the test assertions agree on the same root.
new_root() {
  XT_TEST_ROOT="$(mktemp -d)"
  export XT_INSTALL_ROOT="$XT_TEST_ROOT"
  export XT_RELEASES_DIR="$XT_TEST_ROOT/releases"
  export XT_CURRENT_LINK="$XT_TEST_ROOT/current"
  export XT_CURRENT_POINTER="$XT_TEST_ROOT/current-release.txt"
  export XT_ACTIVE_MANIFEST="$XT_TEST_ROOT/active-release.json"
  mkdir -p "$XT_RELEASES_DIR"
}

# Load the library with the current environment.
load_lib() {
  # shellcheck source=lib/release-layout.sh
  source "$LIB"
}

printf '\n=== TASK-10: immutable versioned deployment directories ===\n\n'

# ---------------------------------------------------------------------------
# Slug sanitisation
# ---------------------------------------------------------------------------
printf 'Slug validation\n'
for bad_slug in '' '.' '..' '.hidden' 'a/b' 'a b' 'v1.2.0;rm -rf' '$(id)' '../etc'; do
  if load_lib && xt_release_slug "$bad_slug" >/dev/null 2>&1; then
    bad "rejects unsafe slug '$bad_slug'" "xt_release_slug accepted it"
  else
    ok "rejects unsafe slug '$bad_slug'"
  fi
done
for good_slug in 'v1.2.0' '1.2.0' 'v1.2.0-abc1234' '20260101-120000'; do
  if load_lib && [[ "$(xt_release_slug "$good_slug")" == "$good_slug" ]]; then
    ok "accepts safe slug '$good_slug'"
  else
    bad "accepts safe slug '$good_slug'"
  fi
done

# ---------------------------------------------------------------------------
# Unique, non-overwritten release directories
# ---------------------------------------------------------------------------
printf '\nRelease directory creation\n'
new_root
load_lib
first="$(xt_create_release_dir v1.2.0 2>/dev/null)"
if [[ -n "$first" && -d "$first" ]]; then
  ok "creates a versioned release directory"
else
  bad "creates a versioned release directory" "got: '$first'"
fi

# Deploying the same version again must be refused: a published release is
# immutable and must never be overwritten.
if xt_create_release_dir v1.2.0 >/dev/null 2>&1; then
  bad "refuses to overwrite an existing release" "second create succeeded"
else
  ok "refuses to overwrite an existing release"
fi

second="$(xt_create_release_dir v1.3.0 2>/dev/null)"
if [[ -n "$second" && "$first" != "$second" && -d "$second" ]]; then
  ok "a new version gets a distinct directory"
else
  bad "a new version gets a distinct directory" "first='$first' second='$second'"
fi

# An invalid version must not create anything.
if xt_create_release_dir 'v1.4.0/evil' >/dev/null 2>&1; then
  bad "rejects an unsafe version segment"
else
  ok "rejects an unsafe version segment"
fi
if [[ ! -d "${XT_RELEASES_DIR}/v1.4.0" ]]; then
  ok "creates no directory for a rejected version"
else
  bad "creates no directory for a rejected version"
fi

# ---------------------------------------------------------------------------
# Activation and the active/previous manifest
# ---------------------------------------------------------------------------
printf '\nActivation and manifest\n'
new_root
load_lib
rel_a="$(xt_create_release_dir v1.2.0)"
printf 'a\n' > "$rel_a/marker.txt"
xt_activate_release "$rel_a" >/dev/null 2>&1

active="$(xt_current_release 2>/dev/null)"
if [[ "$active" == "$rel_a" ]]; then
  ok "current symlink points at the activated release"
else
  bad "current symlink points at the activated release" "active='$active' expected='$rel_a'"
fi
if [[ -f "$XT_ACTIVE_MANIFEST" ]] && grep -q "$rel_a" "$XT_ACTIVE_MANIFEST"; then
  ok "active manifest names the active release"
else
  bad "active manifest names the active release" "manifest missing or wrong"
fi

rel_b="$(xt_create_release_dir v1.3.0)"
xt_activate_release "$rel_b" >/dev/null 2>&1
active="$(xt_current_release 2>/dev/null)"
if [[ "$active" == "$rel_b" && "$active" != "$rel_a" ]]; then
  ok "activating a new release switches current"
else
  bad "activating a new release switches current" "active='$active'"
fi
if grep -q "$rel_a" "$XT_ACTIVE_MANIFEST"; then
  ok "active manifest records the previous release"
else
  bad "active manifest records the previous release" "previous release not recorded"
fi
# The previous release must survive activation: this is what makes rollback possible.
if [[ -d "$rel_a" && -f "$rel_a/marker.txt" ]]; then
  ok "previous release directory is retained"
else
  bad "previous release directory is retained"
fi

# ---------------------------------------------------------------------------
# Interrupted extraction must not disturb the active release
# ---------------------------------------------------------------------------
printf '\nInterrupted extraction recovery\n'
new_root
load_lib
rel_active="$(xt_create_release_dir v1.2.0)"
printf 'good\n' > "$rel_active/marker.txt"
xt_activate_release "$rel_active" >/dev/null 2>&1
before="$(xt_current_release 2>/dev/null)"

# Simulate an interrupted extraction: a candidate directory exists but is
# incomplete. Removing it must not touch the active release.
candidate="${XT_RELEASES_DIR}/v1.3.0"
mkdir -p "$candidate"
printf 'partial\n' > "$candidate/partial.txt"

xt_remove_candidate "$candidate" >/dev/null 2>&1
if [[ ! -d "$candidate" ]]; then
  ok "incomplete candidate is removed"
else
  bad "incomplete candidate is removed"
fi
after="$(xt_current_release 2>/dev/null)"
if [[ "$before" == "$after" && -f "$rel_active/marker.txt" ]]; then
  ok "active release is untouched by candidate cleanup"
else
  bad "active release is untouched by candidate cleanup" "before='$before' after='$after'"
fi

# Cleanup must refuse to delete anything outside the release root.
xt_remove_candidate "$XT_TEST_ROOT/../escape" >/dev/null 2>&1 && r=1 || r=$?
if [[ $r -ne 0 ]]; then
  ok "refuses to remove a path outside the release root"
else
  bad "refuses to remove a path outside the release root" "removal was allowed"
fi
if xt_remove_candidate "/etc" >/dev/null 2>&1; then
  bad "refuses to remove an absolute system path"
else
  ok "refuses to remove an absolute system path"
fi
# The active release must still be there after the refused removals.
if [[ -d "$rel_active" && -f "$rel_active/marker.txt" ]]; then
  ok "active release survives refused removals"
else
  bad "active release survives refused removals"
fi

# Activating a path outside the root must be refused too.
xt_activate_release "/tmp" >/dev/null 2>&1 && r=1 || r=$?
if [[ $r -ne 0 ]]; then
  ok "refuses to activate a path outside the release root"
else
  bad "refuses to activate a path outside the release root" "activation was allowed"
fi

# ---------------------------------------------------------------------------
# Mutable state lives outside the release payload
# ---------------------------------------------------------------------------
printf '\nMutable state separation\n'
new_root
load_lib
rel="$(xt_create_release_dir v1.2.0)"
mkdir -p "$XT_TEST_ROOT/var" "$XT_TEST_ROOT/etc" "$XT_TEST_ROOT/bin"
# Simulate the layout the installer must guarantee: nothing mutable inside rel.
if [[ ! -e "$rel/var" && ! -e "$rel/etc" && ! -e "$rel/bin" ]]; then
  ok "release payload holds no mutable data/config/bin directories"
else
  bad "release payload holds no mutable data/config/bin directories"
fi
# The release directory name must be the version, and dirs must be nested under
# the releases root rather than beside it.
if [[ "$(dirname "$rel")" == "$XT_RELEASES_DIR" ]]; then
  ok "release directories are nested under the releases root"
else
  bad "release directories are nested under the releases root" "got: $rel"
fi

# ---------------------------------------------------------------------------
# Version detection drives the release directory name
# ---------------------------------------------------------------------------
printf '\nVersion detection\n'
new_root
load_lib
printf '{"version":"1.2.0"}\n' > "$XT_TEST_ROOT/release-manifest.json"
if detected="$(xt_detect_version "$XT_TEST_ROOT" 2>/dev/null)" && [[ "$detected" == "v1.2.0" ]]; then
  ok "reads the version from the release manifest"
else
  bad "reads the version from the release manifest" "got: '$detected'"
fi
rm -f "$XT_TEST_ROOT/release-manifest.json"
printf '{"name":"xistance-panel","version":"1.3.0"}\n' > "$XT_TEST_ROOT/package.json"
if detected="$(xt_detect_version "$XT_TEST_ROOT" 2>/dev/null)" && [[ "$detected" == "v1.3.0" ]]; then
  ok "falls back to the package version"
else
  bad "falls back to the package version" "got: '$detected'"
fi
rm -f "$XT_TEST_ROOT/package.json"
if xt_detect_version "$XT_TEST_ROOT" >/dev/null 2>&1; then
  bad "reports failure when no version can be determined"
else
  ok "reports failure when no version can be determined"
fi

# The detected version must be usable as a real release directory name.
new_root
load_lib
printf '{"name":"xistance-panel","version":"1.2.0"}\n' > "$XT_TEST_ROOT/package.json"
detected="$(xt_detect_version "$XT_TEST_ROOT")"
if dir="$(xt_create_release_dir "$detected" 2>/dev/null)" && [[ "$(basename "$dir")" == "v1.2.0" ]]; then
  ok "detected version produces the expected release directory name"
else
  bad "detected version produces the expected release directory name" "dir='$dir'"
fi

# ---------------------------------------------------------------------------
# TASK-108: a re-activation must not record `previous` as the active release.
#
# The record is well-formed JSON either way, so nothing that only checks
# "active and previous exist" would notice. The failure mode is not a crash --
# it is the rollback path silently becoming one-way, because the only release
# named is the one already running.
# ---------------------------------------------------------------------------
echo
echo "Re-activation does not erase the rollback history"
mkdir -p "$XT_INSTALL_ROOT/releases/v1.0.0" "$XT_INSTALL_ROOT/releases/v1.1.0"
xt_activate_release "$XT_INSTALL_ROOT/releases/v1.0.0" >/dev/null 2>&1
xt_activate_release "$XT_INSTALL_ROOT/releases/v1.1.0" >/dev/null 2>&1
before_prev="$(sed -n 's/.*"previous"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$XT_ACTIVE_MANIFEST" | head -1)"

if [[ "$before_prev" == "$XT_INSTALL_ROOT/releases/v1.0.0" ]]; then
  ok "a real switch records the release it replaced"
else
  bad "a real switch records the release it replaced" "previous='$before_prev'"
fi

# Re-activate the release that is ALREADY current.
xt_activate_release "$XT_INSTALL_ROOT/releases/v1.1.0" >/dev/null 2>&1
after_active="$(sed -n 's/.*"active"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$XT_ACTIVE_MANIFEST" | head -1)"
after_prev="$(sed -n 's/.*"previous"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$XT_ACTIVE_MANIFEST" | head -1)"

if [[ "$after_prev" != "$after_active" ]]; then
  ok "re-activation leaves previous distinct from active (or empty)"
else
  bad "re-activation leaves previous distinct from active (or empty)" \
    "active == previous == '$after_active', so the rollback path is one-way"
fi

if [[ "$after_prev" == "$XT_INSTALL_ROOT/releases/v1.0.0" ]]; then
  ok "re-activation preserves the recorded rollback target"
else
  bad "re-activation preserves the recorded rollback target" "previous='$after_prev'"
fi

printf '\n--- %d passed, %d failed ---\n\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
