#!/usr/bin/env bash
# Focused tests for the atomic active-release cutover (TASK-11).
#
# Runs the real functions from scripts/lib/release-layout.sh. The readiness
# probe is a test double, so a failing probe deterministically exercises the
# rollback path.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="${SCRIPT_DIR}/lib/release-layout.sh"

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; [[ $# -gt 1 ]] && printf '      %s\n' "$2"; }

new_root() {
  XT_TEST_ROOT="$(mktemp -d)"
  export XT_INSTALL_ROOT="$XT_TEST_ROOT"
  export XT_RELEASES_DIR="$XT_TEST_ROOT/releases"
  export XT_CURRENT_LINK="$XT_TEST_ROOT/current"
  export XT_CURRENT_POINTER="$XT_TEST_ROOT/current-release.txt"
  export XT_ACTIVE_MANIFEST="$XT_TEST_ROOT/active-release.json"
  export XT_RELEASE_STATE_DIR="$XT_TEST_ROOT/state"
  mkdir -p "$XT_RELEASES_DIR" "$XT_RELEASE_STATE_DIR"
}

load_lib() { source "$LIB"; }

printf '\n=== TASK-11: atomic active-release cutover ===\n\n'

# ---------------------------------------------------------------------------
# Cutover replaces the pointer without touching the previous release
# ---------------------------------------------------------------------------
printf 'Cutover\n'
new_root; load_lib
rel_a="$(xt_create_release_dir v1.2.0)"
printf 'a\n' > "$rel_a/marker.txt"
xt_activate_release "$rel_a" >/dev/null 2>&1
before="$(xt_current_release)"

rel_b="$(xt_create_release_dir v1.3.0)"
printf 'b\n' > "$rel_b/marker.txt"
if xt_activate_release "$rel_b" >/dev/null 2>&1 && [[ "$(xt_current_release)" == "$rel_b" ]]; then
  ok "cutover switches the active pointer to the new release"
else
  bad "cutover switches the active pointer to the new release"
fi
if [[ -f "$rel_a/marker.txt" ]]; then
  ok "cutover does not modify the previous release directory"
else
  bad "cutover does not modify the previous release directory"
fi

# A cutover must never be an in-place overwrite: the old directory must still
# exist as its own directory.
if [[ -d "$rel_a" && "$rel_a" != "$rel_b" ]]; then
  ok "previous release remains a separate directory"
else
  bad "previous release remains a separate directory"
fi

# ---------------------------------------------------------------------------
# Failed readiness check rolls the pointer back
# ---------------------------------------------------------------------------
printf '\nFailed readiness check\n'
new_root; load_lib
rel_ok="$(xt_create_release_dir v1.2.0)"
printf 'ok\n' > "$rel_ok/marker.txt"
xt_activate_release "$rel_ok" >/dev/null 2>&1

rel_bad="$(xt_create_release_dir v1.3.0)"
printf 'bad\n' > "$rel_bad/marker.txt"

# A failing readiness probe must leave the active pointer on the previous
# release and mark the candidate as failed.
if xt_cutover_with_health_check "$rel_bad" false >/dev/null 2>&1; then
  bad "cutover reports failure when readiness fails"
else
  ok "cutover reports failure when readiness fails"
fi
if [[ "$(xt_current_release)" == "$rel_ok" ]]; then
  ok "failed readiness returns the pointer to the previous release"
else
  bad "failed readiness returns the pointer to the previous release" \
      "active='$(xt_current_release)' expected='$rel_ok'"
fi
if [[ -f "$XT_RELEASE_STATE_DIR/failed-v1.3.0" ]]; then
  ok "failed candidate is recorded as failed"
else
  bad "failed candidate is recorded as failed"
fi
# The failed candidate must not be silently deleted; it is retained for
# diagnosis and cleaned up explicitly later.
if [[ -d "$rel_bad" ]]; then
  ok "failed candidate directory is retained for diagnosis"
else
  bad "failed candidate directory is retained for diagnosis"
fi

# A successful readiness check must activate the new release.
rel_good="$(xt_create_release_dir v1.4.0)"
printf 'good\n' > "$rel_good/marker.txt"
if xt_cutover_with_health_check "$rel_good" true >/dev/null 2>&1; then
  ok "cutover succeeds when readiness passes"
else
  bad "cutover succeeds when readiness passes"
fi
if [[ "$(xt_current_release)" == "$rel_good" ]]; then
  ok "successful cutover activates the new release"
else
  bad "successful cutover activates the new release" "active='$(xt_current_release)'"
fi

# ---------------------------------------------------------------------------
# Previous release is identifiable for deterministic rollback
# ---------------------------------------------------------------------------
printf '\nPrevious release tracking\n'
new_root; load_lib
r1="$(xt_create_release_dir v1.2.0)"; xt_activate_release "$r1" >/dev/null 2>&1
r2="$(xt_create_release_dir v1.3.0)"; xt_activate_release "$r2" >/dev/null 2>&1

if prev="$(xt_previous_release 2>/dev/null)" && [[ "$prev" == "$r1" ]]; then
  ok "previous release is reported from the manifest"
else
  bad "previous release is reported from the manifest" "prev='$prev' expected='$r1'"
fi
if xt_previous_release 2>/dev/null | grep -q "$XT_RELEASES_DIR"; then
  ok "previous release path stays inside the release root"
else
  bad "previous release path stays inside the release root"
fi

# Status output must name both releases and leak nothing sensitive.
status_out="$(xt_status_report 2>/dev/null)"
if printf '%s' "$status_out" | grep -q "$r2"; then
  ok "status output names the active release"
else
  bad "status output names the active release" "got: $status_out"
fi
if printf '%s' "$status_out" | grep -q "$r1"; then
  ok "status output names the previous release"
else
  bad "status output names the previous release" "got: $status_out"
fi
for secret_marker in JWT_SECRET password token secret; do
  if printf '%s' "$status_out" | grep -qi "$secret_marker"; then
    bad "status output excludes '$secret_marker'"
  else
    ok "status output excludes '$secret_marker'"
  fi
done

# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------
printf '\nRefusals\n'
new_root; load_lib
if xt_cutover_with_health_check "/tmp" true >/dev/null 2>&1; then
  bad "refuses to cut over to a path outside the release root"
else
  ok "refuses to cut over to a path outside the release root"
fi
if xt_cutover_with_health_check "$XT_TEST_ROOT/../escape" true >/dev/null 2>&1; then
  bad "refuses to cut over through a traversal path"
else
  ok "refuses to cut over through a traversal path"
fi

printf '\n--- %d passed, %d failed ---\n\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
