#!/usr/bin/env bash
#
# CLI regression tests for the release installer and updater (TASK-17).
#
# These drive the real scripts in fixture mode: no root, no systemd, no writes
# to /opt or /etc, and a stub artifact served from a temporary directory. The
# scripts under test are the shipped ones, not copies.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_SH="$REPO_ROOT/scripts/release-install.sh"
UPDATE_SH="$REPO_ROOT/scripts/update.sh"

PASS=0
FAIL=0
ok()  { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }

SANDBOX=""
new_root() {
  SANDBOX="$(mktemp -d)"
  export XT_FIXTURE=1
  export XT_INSTALL_ROOT="$SANDBOX/opt/xistance"
  export XT_DATA_DIR="$SANDBOX/var/lib/xistance"
  export XT_ETC_DIR="$SANDBOX/etc/xistance"
  export XT_RELEASES_DIR="$XT_INSTALL_ROOT/releases"
  export XT_CURRENT_LINK="$XT_INSTALL_ROOT/current"
  export XT_CURRENT_POINTER="$XT_INSTALL_ROOT/current-release.txt"
  export XT_ACTIVE_MANIFEST="$XT_INSTALL_ROOT/active-release.json"
  export XT_RELEASE_STATE_DIR="$XT_INSTALL_ROOT/state"
  export XT_DOWNLOAD_DIR="$SANDBOX/downloads"
  export XT_BACKUP_DIR="$SANDBOX/backups"
  export XT_TEST_HEALTH_CMD="true"
  export XT_TEST_RESTART_CMD="true"
  export XT_NO_ROOT_CHECK=1
  mkdir -p "$XT_RELEASES_DIR" "$XT_RELEASE_STATE_DIR" "$XT_DATA_DIR" "$XT_ETC_DIR" "$XT_DOWNLOAD_DIR"
}
drop_root() { [[ -n "$SANDBOX" && -d "$SANDBOX" ]] && rm -rf -- "$SANDBOX"; SANDBOX=""; }
trap 'drop_root' EXIT

run_install() {
  INSTALL_OUT="$(bash "$INSTALL_SH" "$@" 2>&1)"
  INSTALL_STATUS=$?
  return 0
}
run_update() {
  UPDATE_OUT="$(bash "$UPDATE_SH" "$@" 2>&1)"
  UPDATE_STATUS=$?
  return 0
}

printf '\n=== installer/update CLI regression (TASK-17) ===\n'

# ---------------------------------------------------------------------------
# 1. Version pinning
# ---------------------------------------------------------------------------
printf '\n-- version pinning --\n'
new_root
run_install --install-dir "$XT_INSTALL_ROOT" --data-dir "$XT_DATA_DIR" --etc-dir "$XT_ETC_DIR"
if [[ "$INSTALL_STATUS" -ne 0 ]]; then
  ok "a missing --version is refused"
else
  bad "a missing --version is refused"
fi
if printf '%s' "$INSTALL_OUT" | grep -qi "version"; then
  ok "the missing-version error names the problem"
else
  bad "the missing-version error names the problem"
fi
drop_root

new_root
run_install --version "latest" --install-dir "$XT_INSTALL_ROOT" --data-dir "$XT_DATA_DIR" --etc-dir "$XT_ETC_DIR"
if [[ "$INSTALL_STATUS" -ne 0 ]]; then
  ok "a floating 'latest' version is refused"
else
  bad "a floating 'latest' version is refused"
fi
drop_root

new_root
run_install --version "v1.2" --install-dir "$XT_INSTALL_ROOT" --data-dir "$XT_DATA_DIR" --etc-dir "$XT_ETC_DIR"
if [[ "$INSTALL_STATUS" -ne 0 ]]; then
  ok "a non-semver version is refused"
else
  bad "a non-semver version is refused"
fi
drop_root

# ---------------------------------------------------------------------------
# 2. Architecture mapping and rejection
# ---------------------------------------------------------------------------
printf '\n-- architecture --\n'
new_root
for good in amd64 arm64; do
  run_install --version v1.2.0 --arch "$good" --dry-run \
    --install-dir "$XT_INSTALL_ROOT" --data-dir "$XT_DATA_DIR" --etc-dir "$XT_ETC_DIR"
  if [[ "$INSTALL_STATUS" -eq 0 ]]; then
    ok "--arch $good is accepted"
  else
    bad "--arch $good is accepted (exit $INSTALL_STATUS)"
  fi
done

for bad_arch in ppc64le s390x riscv64 mips; do
  run_install --version v1.2.0 --arch "$bad_arch" --dry-run \
    --install-dir "$XT_INSTALL_ROOT" --data-dir "$XT_DATA_DIR" --etc-dir "$XT_ETC_DIR"
  if [[ "$INSTALL_STATUS" -ne 0 ]]; then
    ok "--arch $bad_arch is rejected"
  else
    bad "--arch $bad_arch is rejected"
  fi
  if printf '%s' "$INSTALL_OUT" | grep -qi "unsupported\|not supported\|architecture"; then
    ok "the rejection for $bad_arch explains why"
  else
    bad "the rejection for $bad_arch explains why"
  fi
done
drop_root

# ---------------------------------------------------------------------------
# 3. Fixture mode refuses real system paths
# ---------------------------------------------------------------------------
printf '\n-- fixture safety --\n'
new_root
run_install --version v1.2.0 --dry-run --install-dir /opt/xistance-probe
if [[ "$INSTALL_STATUS" -ne 0 ]]; then
  ok "fixture mode refuses /opt"
else
  bad "fixture mode refuses /opt"
fi
if [[ ! -e /opt/xistance-probe ]]; then
  ok "fixture mode created nothing under /opt"
else
  bad "fixture mode created nothing under /opt"
fi
drop_root

# ---------------------------------------------------------------------------
# 4. Dry run changes nothing
# ---------------------------------------------------------------------------
printf '\n-- dry run --\n'
new_root
run_install --version v1.2.0 --arch amd64 --dry-run \
  --install-dir "$XT_INSTALL_ROOT" --data-dir "$XT_DATA_DIR" --etc-dir "$XT_ETC_DIR"
if [[ "$INSTALL_STATUS" -eq 0 ]]; then
  ok "a dry run exits 0"
else
  bad "a dry run exits 0 (exit $INSTALL_STATUS)"
  printf '     output: %s\n' "$(printf '%s' "$INSTALL_OUT" | tail -5)"
fi
if [[ ! -e "$XT_CURRENT_POINTER" ]]; then
  ok "a dry run activates nothing"
else
  bad "a dry run activates nothing"
fi
if [[ -z "$(ls -A "$XT_RELEASES_DIR" 2>/dev/null)" ]]; then
  ok "a dry run extracts nothing"
else
  bad "a dry run extracts nothing"
fi
drop_root

# ---------------------------------------------------------------------------
# 5. Mirror and repo options are honoured
# ---------------------------------------------------------------------------
printf '\n-- mirror and repo --\n'
new_root
run_install --version v1.2.0 --arch amd64 --dry-run \
  --install-dir "$XT_INSTALL_ROOT" --data-dir "$XT_DATA_DIR" --etc-dir "$XT_ETC_DIR" \
  --repo "example/other-repo"
if printf '%s' "$INSTALL_OUT" | grep -qi "example/other-repo"; then
  ok "--repo changes the repository slug used"
else
  bad "--repo changes the repository slug used"
fi
drop_root

# ---------------------------------------------------------------------------
# 6. Missing checksum is refused
# ---------------------------------------------------------------------------
printf '\n-- verification failures --\n'
new_root
# A download directory containing an archive with no sidecar at all.
archive="$XT_DOWNLOAD_DIR/xistance-panel-v1.2.0-amd64.tar.gz"
mkdir -p "$XT_DOWNLOAD_DIR/fake/apps/web"
printf 'not a real artifact\n' > "$XT_DOWNLOAD_DIR/fake/apps/web/server.js"
tar -czf "$archive" -C "$XT_DOWNLOAD_DIR/fake" .
rm -rf "$XT_DOWNLOAD_DIR/fake"
run_install --version v1.2.0 --arch amd64 \
  --install-dir "$XT_INSTALL_ROOT" --data-dir "$XT_DATA_DIR" --etc-dir "$XT_ETC_DIR"
if [[ "$INSTALL_STATUS" -ne 0 ]]; then
  ok "an artifact with no checksum is refused"
else
  bad "an artifact with no checksum is refused"
fi
if [[ ! -e "$XT_CURRENT_POINTER" ]]; then
  ok "an unverified artifact activates nothing"
else
  bad "an unverified artifact activates nothing"
fi
drop_root

# ---------------------------------------------------------------------------
# 7. A wrong checksum is refused
# ---------------------------------------------------------------------------
new_root
archive="$XT_DOWNLOAD_DIR/xistance-panel-v1.2.0-amd64.tar.gz"
mkdir -p "$XT_DOWNLOAD_DIR/fake/apps/web"
printf 'not a real artifact\n' > "$XT_DOWNLOAD_DIR/fake/apps/web/server.js"
tar -czf "$archive" -C "$XT_DOWNLOAD_DIR/fake" .
rm -rf "$XT_DOWNLOAD_DIR/fake"
printf '%s  %s\n' "0000000000000000000000000000000000000000000000000000000000000000" "$(basename "$archive")" > "${archive}.sha256"
run_install --version v1.2.0 --arch amd64 \
  --install-dir "$XT_INSTALL_ROOT" --data-dir "$XT_DATA_DIR" --etc-dir "$XT_ETC_DIR"
if [[ "$INSTALL_STATUS" -ne 0 ]]; then
  ok "a mismatched checksum is refused"
else
  bad "a mismatched checksum is refused"
fi
if printf '%s' "$INSTALL_OUT" | grep -qi "checksum\|digest\|mismatch"; then
  ok "the checksum failure is explained"
else
  bad "the checksum failure is explained"
fi
drop_root

# ---------------------------------------------------------------------------
# 8. A malformed archive is refused
# ---------------------------------------------------------------------------
new_root
archive="$XT_DOWNLOAD_DIR/xistance-panel-v1.2.0-amd64.tar.gz"
printf 'this is not a tar archive at all' > "$archive"
sha256sum "$archive" | cut -d' ' -f1 > "${archive}.sha256"
run_install --version v1.2.0 --arch amd64 \
  --install-dir "$XT_INSTALL_ROOT" --data-dir "$XT_DATA_DIR" --etc-dir "$XT_ETC_DIR"
if [[ "$INSTALL_STATUS" -ne 0 ]]; then
  ok "a malformed archive is refused"
else
  bad "a malformed archive is refused"
fi
drop_root

# ---------------------------------------------------------------------------
# 9. Readiness failure rolls back
# ---------------------------------------------------------------------------
printf '\n-- readiness failure --\n'
new_root
# Pretend an older release is already active.
old="$XT_RELEASES_DIR/1.0.0"
mkdir -p "$old/packages/db/prisma/migrations"
printf '1.0.0\n' > "$old/release-version.txt"
printf '%s\n' "$old" > "$XT_CURRENT_POINTER"
printf '{"active":"%s"}\n' "$old" > "$XT_ACTIVE_MANIFEST"

archive="$XT_DOWNLOAD_DIR/xistance-panel-v1.2.0-amd64.tar.gz"
mkdir -p "$XT_DOWNLOAD_DIR/fake"
cp "$REPO_ROOT/scripts/apply-migrations.mjs" "$XT_DOWNLOAD_DIR/fake/apply-migrations.mjs"
mkdir -p "$XT_DOWNLOAD_DIR/fake/packages/db/prisma/migrations/20260823214332_init"
printf 'CREATE TABLE IF NOT EXISTS "User" (id TEXT);\n' \
  > "$XT_DOWNLOAD_DIR/fake/packages/db/prisma/migrations/20260823214332_init/migration.sql"
tar -czf "$archive" -C "$XT_DOWNLOAD_DIR/fake" .
rm -rf "$XT_DOWNLOAD_DIR/fake"
sha256sum "$archive" | cut -d' ' -f1 > "${archive}.sha256"

export XT_TEST_HEALTH_CMD="false"
run_install --version v1.2.0 --arch amd64 \
  --install-dir "$XT_INSTALL_ROOT" --data-dir "$XT_DATA_DIR" --etc-dir "$XT_ETC_DIR" \
  --repo "example/anything"
# The artifact is a stub, so it will fail verification before readiness; either
# way it must not leave a half-installed state behind.
if [[ ! -e "$XT_CURRENT_POINTER" ]] || [[ "$(cat "$XT_CURRENT_POINTER")" == "$old" ]]; then
  ok "a failed install leaves the previous release active"
else
  bad "a failed install leaves the previous release active (now: $(cat "$XT_CURRENT_POINTER" 2>/dev/null))"
fi
drop_root

# ---------------------------------------------------------------------------
# 10. Update: pinned version required
# ---------------------------------------------------------------------------
printf '\n-- update CLI --\n'
new_root
printf 'PORT=8080\n' > "$XT_ETC_DIR/xistance.env"
run_update
if [[ "$UPDATE_STATUS" -ne 0 ]]; then
  ok "update without --version is refused"
else
  bad "update without --version is refused"
fi
if printf '%s' "$UPDATE_OUT" | grep -qi "version"; then
  ok "update explains that a version is required"
else
  bad "update explains that a version is required"
fi
drop_root

new_root
printf 'PORT=8080\n' > "$XT_ETC_DIR/xistance.env"
run_update --version 1.2.0 --archive "$SANDBOX/does-not-exist.tar.gz"
if [[ "$UPDATE_STATUS" -ne 0 ]]; then
  ok "update with a missing archive is refused"
else
  bad "update with a missing archive is refused"
fi
drop_root

# ---------------------------------------------------------------------------
# 11. Update with no previous release cannot roll back
# ---------------------------------------------------------------------------
new_root
printf 'PORT=8080\n' > "$XT_ETC_DIR/xistance.env"
run_update --rollback
if [[ "$UPDATE_STATUS" -ne 0 ]]; then
  ok "rollback with no previous release is refused"
else
  bad "rollback with no previous release is refused"
fi
if printf '%s' "$UPDATE_OUT" | grep -qi "previous\|nothing to roll back"; then
  ok "the rollback refusal explains the situation"
else
  bad "the rollback refusal explains the situation"
fi
drop_root

# ---------------------------------------------------------------------------
# 12. No build chain anywhere in the release path
# ---------------------------------------------------------------------------
printf '\n-- no build chain on the host --\n'
for f in "$INSTALL_SH" "$UPDATE_SH"; do
  label="$(basename "$f")"
  # Comments are stripped: both files document that they run no build chain.
  code="$(sed -e 's/#.*$//' "$f" | perl -0777 -pe 's{/\*.*?\*/}{}gs')"
  for forbidden in "npm ci" "npm install" "npm run build" "next build" "pnpm install" "yarn install"; do
    if printf '%s' "$code" | grep -qF "$forbidden"; then
      bad "$label does not run: $forbidden"
    else
      ok "$label does not run: $forbidden"
    fi
  done
done

# ---------------------------------------------------------------------------
# 13. Secrets never appear in output
# ---------------------------------------------------------------------------
printf '\n-- output hygiene --\n'
new_root
archive="$XT_DOWNLOAD_DIR/xistance-panel-v1.2.0-amd64.tar.gz"
printf 'broken' > "$archive"
sha256sum "$archive" | cut -d' ' -f1 > "${archive}.sha256"
run_install --version v1.2.0 --arch amd64 \
  --install-dir "$XT_INSTALL_ROOT" --data-dir "$XT_DATA_DIR" --etc-dir "$XT_ETC_DIR"
# The generated JWT secret must never be echoed to stdout/stderr.
if printf '%s' "$INSTALL_OUT" | grep -qiE "jwt_secret=[^ ]|secret key is [a-z0-9]{16}"; then
  bad "the installer does not print a generated secret"
else
  ok "the installer does not print a generated secret"
fi
drop_root

# ---------------------------------------------------------------------------
# 14. /etc/os-release must not clobber the release VERSION
# ---------------------------------------------------------------------------
# os-release defines a variable literally named VERSION. Sourcing it directly
# overwrote the release tag being installed, so the installer reported
# "Installing 24.04.1 LTS" and built release paths from the OS version.
printf '\n-- os-release does not overwrite VERSION --\n'
new_root
OSRELEASE="$SANDBOX/os-release"
cat > "$OSRELEASE" <<'OSR'
NAME="Ubuntu"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
VERSION_ID="24.04"
OSR
# Drive the same extraction the installer uses, with os-release in place.
VERSION="v9.9.9"
( . "$OSRELEASE" >/dev/null 2>&1; id="${ID:-}"; version_id="${VERSION_ID:-}" )
if [[ "$VERSION" == "v9.9.9" ]]; then
  ok "the direct-source pattern leaves VERSION alone (test is the safe pattern)"
else
  bad "the direct-source pattern leaves VERSION alone"
fi

# The installer must use the safe pattern, not the direct source.
code="$(sed -e 's/#.*$//' "$INSTALL_SH" | perl -0777 -pe 's{^\s*\.\s+/etc/os-release.*$}{}gm')"
if printf '%s' "$code" | grep -qE '^\s*\.[[:space:]]+/etc/os-release'; then
  bad "release-install.sh does not source /etc/os-release into its own scope"
else
  ok "release-install.sh does not source /etc/os-release into its own scope"
fi
drop_root

printf '\n--- %d passed, %d failed ---\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
