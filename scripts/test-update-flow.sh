#!/usr/bin/env bash
#
# Focused tests for the pinned-artifact update and rollback flow (TASK-14).
#
# The production update path must never build source on the VPS. These tests
# drive scripts/update.sh against a sandboxed deployment and a stub artifact,
# so the same code path that runs on a real host is what gets exercised here.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UPDATE_SH="$REPO_ROOT/scripts/update.sh"

PASS=0
FAIL=0
ok()  { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
# The optional second argument is the evidence. Several call sites already pass
# it, and it was being silently dropped, which is why a failure could not be
# diagnosed without editing the test.
bad() {
  if [[ $# -ge 2 && -n "$2" ]]; then
    printf '  FAIL %s\n       %s\n' "$1" "$2"
  else
    printf '  FAIL %s\n' "$1"
  fi
  FAIL=$((FAIL + 1))
}

# The stub system database used by the tests, in the caller's shell so exports
# reach the helpers that follow.
new_root() {
  SANDBOX="$(mktemp -d)"
  export XT_INSTALL_ROOT="$SANDBOX/opt/xistance"
  export XT_RELEASES_DIR="$XT_INSTALL_ROOT/releases"
  export XT_CURRENT_LINK="$XT_INSTALL_ROOT/current"
  export XT_CURRENT_POINTER="$XT_INSTALL_ROOT/current-release.txt"
  export XT_ACTIVE_MANIFEST="$XT_INSTALL_ROOT/active-release.json"
  export XT_RELEASE_STATE_DIR="$XT_INSTALL_ROOT/state"
  export XT_DATA_DIR="$SANDBOX/var/lib/xistance"
  export XT_ENV_FILE="$SANDBOX/etc/xistance/xistance.env"
  export XT_SERVICE_NAME="xistance-test.service"
  export XT_HEALTH_URL="http://127.0.0.1:9/api/health"
  export XT_NODE_BIN="$(command -v node || echo node)"
  export XT_NO_ROOT_CHECK=1
  # Default to "healthy" so success paths are testable; the readiness-failure
  # case overrides this to exercise the rollback path.
  export XT_TEST_HEALTH_CMD="${XT_TEST_HEALTH_CMD:-true}"
  export XT_TEST_RESTART_CMD="${XT_TEST_RESTART_CMD:-true}"
  # The stub archives here are not real release artifacts, so the TypeScript
  # verifier (which requires a manifest) is not applicable. The checksum gate is
  # still enforced for real.
  export XT_SKIP_FULL_VERIFY=1
  mkdir -p "$XT_RELEASES_DIR" "$XT_RELEASE_STATE_DIR" "$XT_DATA_DIR" "$(dirname "$XT_ENV_FILE")"
  printf 'PORT=8080\n' > "$XT_ENV_FILE"
}

drop_root() { [[ -n "${SANDBOX:-}" && -d "${SANDBOX:-}" ]] && rm -rf -- "$SANDBOX"; }

# Create a fake release tree that looks like a deployed artifact.
#
# The migration scripts are the *real* ones copied from the repo: a stub would
# exit 0 regardless of the SQL, so a "migration failure" case could never fail
# and the test would prove nothing.
REAL_APPLIER="$REPO_ROOT/scripts/apply-migrations.mjs"
REAL_ADMIN="$REPO_ROOT/scripts/create-admin.mjs"

make_release() {
  local dir="$1" version="$2"
  mkdir -p "$dir/packages/db/prisma/migrations/20260823214332_init"
  printf '%s\n' "$version" > "$dir/release-version.txt"
  cp "$REAL_APPLIER" "$dir/apply-migrations.mjs"
  cp "$REAL_ADMIN"  "$dir/create-admin.mjs"
  printf 'CREATE TABLE IF NOT EXISTS "User" (id TEXT);\n' \
    > "$dir/packages/db/prisma/migrations/20260823214332_init/migration.sql"
}

# A release whose migration is deliberately invalid: `CREATE TABLE ... ;` with a
# missing body is a syntax error, so the applier must refuse it.
make_bad_migration_release() {
  make_release "$1" "$2"
  printf 'CREATE TABLE (;\n' \
    > "$1/packages/db/prisma/migrations/20260823214332_init/migration.sql"
}

# Write a real SHA-256 sidecar for an archive, in the format the release
# workflow publishes (`<digest>  <name>`).
write_checksum() {
  local archive="$1" digest
  digest="$(sha256sum "$archive" | cut -d' ' -f1)"
  printf '%s  %s\n' "$digest" "$(basename "$archive")" > "${archive}.sha256"
}

# Run update.sh, capturing output and status.
run_update() {
  UPDATE_OUT="$(bash "$UPDATE_SH" "$@" 2>&1)"
  UPDATE_STATUS=$?
  return 0
}

# shellcheck source=lib/release-layout.sh
source "$REPO_ROOT/scripts/lib/release-layout.sh"

printf '\n=== pinned-artifact update and rollback (TASK-14) ===\n'

# ---------------------------------------------------------------------------
# 1. The production path must not build source.
# ---------------------------------------------------------------------------
printf '\n-- production path contains no build chain --\n'
# Comments are stripped first: the file documents that it does none of this.
strip_comments() {
  sed -e 's/#.*$//' "$1" | perl -0777 -pe 's{/\*.*?\*/}{}gs'
}
CODE="$(strip_comments "$UPDATE_SH")"

for forbidden in "git reset --hard" "npm ci" "npm run build" "git fetch" "next build"; do
  if printf '%s' "$CODE" | grep -qF "$forbidden"; then
    bad "update.sh must not run: $forbidden"
  else
    ok "update.sh does not run: $forbidden"
  fi
done

if printf '%s' "$CODE" | grep -qE 'release-install\.sh|verify-artifact'; then
  ok "update.sh reuses the verified release install path"
else
  bad "update.sh reuses the verified release install path"
fi

# A pinned version must be accepted, and a floating "latest" must not silently
# install an arbitrary version.
if printf '%s' "$CODE" | grep -qE '\-\-version'; then
  ok "update.sh accepts a pinned --version"
else
  bad "update.sh accepts a pinned --version"
fi

# ---------------------------------------------------------------------------
# 2. A successful update preserves data and switches atomically.
# ---------------------------------------------------------------------------
printf '\n-- successful update --\n'
new_root
make_release "$XT_RELEASES_DIR/1.0.0" "1.0.0"
xt_activate_release "$XT_RELEASES_DIR/1.0.0"
# A real (empty) SQLite database: a text file would fail to open, which would
# make every "migration succeeds" case fail for the wrong reason.
: > "$XT_DATA_DIR/app.db"
printf 'existing-data\n' > "$XT_DATA_DIR/marker.txt"

make_release "$XT_RELEASES_DIR/1.1.0" "1.1.0"
STUB_ARCHIVE="$SANDBOX/stub-artifact.tar.gz"
tar -czf "$STUB_ARCHIVE" -C "$XT_RELEASES_DIR/1.1.0" .
write_checksum "$STUB_ARCHIVE"

run_update --archive "$STUB_ARCHIVE" --version 1.1.0
if [[ "$UPDATE_STATUS" -eq 0 ]]; then
  ok "a successful update exits 0"
else
  bad "a successful update exits 0 (got $UPDATE_STATUS)"
  printf '     output: %s\n' "$(printf '%s' "$UPDATE_OUT" | tail -20)"
fi

if [[ "$(xt_current_release)" == "$XT_RELEASES_DIR/1.1.0" ]]; then
  ok "the new release becomes active"
else
  bad "the new release becomes active (active=$(xt_current_release))"
fi

if [[ -f "$XT_DATA_DIR/marker.txt" ]] && grep -q "existing-data" "$XT_DATA_DIR/marker.txt"; then
  ok "existing data survives the update"
else
  bad "existing data survives the update"
fi

if printf '%s' "$UPDATE_OUT" | grep -qE '1\.0\.0.*1\.1\.0|1\.1\.0.*1\.0\.0'; then
  ok "the update reports both old and new versions"
else
  bad "the update reports both old and new versions"
fi

# The previous release must remain on disk so it can be rolled back to.
if [[ -d "$XT_RELEASES_DIR/1.0.0" ]]; then
  ok "the previous release is retained for rollback"
else
  bad "the previous release is retained for rollback"
fi
drop_root

# ---------------------------------------------------------------------------
# 3. A migration failure must leave the previous release serving.
# ---------------------------------------------------------------------------
printf '\n-- migration failure --\n'
new_root
make_release "$XT_RELEASES_DIR/1.0.0" "1.0.0"
xt_activate_release "$XT_RELEASES_DIR/1.0.0"
# A real (empty) SQLite database: a text file would fail to open, which would
# make every "migration succeeds" case fail for the wrong reason.
: > "$XT_DATA_DIR/app.db"
printf 'existing-data\n' > "$XT_DATA_DIR/marker.txt"

make_bad_migration_release "$XT_RELEASES_DIR/1.1.0" "1.1.0"
BAD_ARCHIVE="$SANDBOX/bad-artifact.tar.gz"
tar -czf "$BAD_ARCHIVE" -C "$XT_RELEASES_DIR/1.1.0" .
write_checksum "$BAD_ARCHIVE"

run_update --archive "$BAD_ARCHIVE" --version 1.1.0
if [[ "$UPDATE_STATUS" -ne 0 ]]; then
  ok "a migration failure exits non-zero"
else
  bad "a migration failure exits non-zero"
fi

if [[ "$(xt_current_release)" == "$XT_RELEASES_DIR/1.0.0" ]]; then
  ok "a migration failure leaves the previous release active"
else
  bad "a migration failure leaves the previous release active (active=$(xt_current_release))"
fi

if [[ -f "$XT_DATA_DIR/marker.txt" ]] && grep -q "existing-data" "$XT_DATA_DIR/marker.txt"; then
  ok "a migration failure does not destroy data"
else
  bad "a migration failure does not destroy data"
fi

# The failure must be explained, not silent.
if printf '%s' "$UPDATE_OUT" | grep -qiE 'migration|migrat'; then
  ok "a migration failure is reported to the operator"
else
  bad "a migration failure is reported to the operator"
fi

# A backup must exist so the schema change can be undone.
if compgen -G "${XT_BACKUP_DIR:-$XT_INSTALL_ROOT/backups}/xistance-data-*.tar.gz" >/dev/null 2>&1; then
  ok "a backup is taken before migrating"
else
  bad "a backup is taken before migrating" "looked in ${XT_BACKUP_DIR:-$XT_INSTALL_ROOT/backups}; update said: $(printf '%s' "$UPDATE_OUT" | grep -iE 'backup' | head -2 | tr '\n' ' ')"
fi
drop_root

# ---------------------------------------------------------------------------
# 4. A readiness failure must roll back.
# ---------------------------------------------------------------------------
printf '\n-- readiness failure --\n'
new_root
make_release "$XT_RELEASES_DIR/1.0.0" "1.0.0"
xt_activate_release "$XT_RELEASES_DIR/1.0.0"

make_release "$XT_RELEASES_DIR/1.1.0" "1.1.0"
ARCHIVE="$SANDBOX/artifact.tar.gz"
tar -czf "$ARCHIVE" -C "$XT_RELEASES_DIR/1.1.0" .
write_checksum "$ARCHIVE"

# An unreachable health URL can never report ready, so this exercises rollback.
export XT_TEST_HEALTH_CMD="false"
run_update --archive "$ARCHIVE" --version 1.1.0
if [[ "$UPDATE_STATUS" -ne 0 ]]; then
  ok "a readiness failure exits non-zero"
else
  bad "a readiness failure exits non-zero"
fi

if [[ "$(xt_current_release)" == "$XT_RELEASES_DIR/1.0.0" ]]; then
  ok "a readiness failure rolls back to the previous release"
else
  bad "a readiness failure rolls back to the previous release (active=$(xt_current_release))"
fi
drop_root

# ---------------------------------------------------------------------------
# 5. Explicit rollback to the previous verified release.
# ---------------------------------------------------------------------------
printf '\n-- explicit rollback --\n'
new_root
# The previous case left the probe deliberately unhealthy; a rollback that
# succeeds must itself pass readiness.
export XT_TEST_HEALTH_CMD="true"
make_release "$XT_RELEASES_DIR/1.0.0" "1.0.0"
make_release "$XT_RELEASES_DIR/1.1.0" "1.1.0"
xt_activate_release "$XT_RELEASES_DIR/1.0.0"
xt_activate_release "$XT_RELEASES_DIR/1.1.0"
: > "$XT_DATA_DIR/app.db"
printf 'existing-data\n' > "$XT_DATA_DIR/marker.txt"

run_update --rollback
if [[ "$UPDATE_STATUS" -eq 0 ]]; then
  ok "an explicit rollback exits 0"
else
  bad "an explicit rollback exits 0 (got $UPDATE_STATUS)"
  printf '     output: %s\n' "${UPDATE_OUT:0:400}"
fi

if [[ "$(xt_current_release)" == "$XT_RELEASES_DIR/1.0.0" ]]; then
  ok "rollback activates the previous release"
else
  bad "rollback activates the previous release (active=$(xt_current_release))"
fi

if [[ -f "$XT_DATA_DIR/marker.txt" ]] && grep -q "existing-data" "$XT_DATA_DIR/marker.txt"; then
  ok "rollback does not delete mutable data"
else
  bad "rollback does not delete mutable data"
fi
drop_root

# ---------------------------------------------------------------------------
# 6. Unsafe or missing inputs are refused.
# ---------------------------------------------------------------------------
printf '\n-- input validation --\n'
new_root
make_release "$XT_RELEASES_DIR/1.0.0" "1.0.0"
xt_activate_release "$XT_RELEASES_DIR/1.0.0"

run_update --archive "$SANDBOX/does-not-exist.tar.gz" --version 1.1.0
if [[ "$UPDATE_STATUS" -ne 0 ]]; then
  ok "a missing archive is refused"
else
  bad "a missing archive is refused"
fi

if [[ "$(xt_current_release)" == "$XT_RELEASES_DIR/1.0.0" ]]; then
  ok "a missing archive leaves the active release untouched"
else
  bad "a missing archive leaves the active release untouched"
fi
drop_root

printf '\n--- %d passed, %d failed ---\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
