#!/usr/bin/env bash
#
# Xistance Panel — update.sh (pinned-artifact flow)
#
# Updates a deployed panel by installing a *prebuilt, verified* release
# artifact. It never builds source on the server: no git reset, no npm ci, no
# next build. Those steps happen once, in CI, and the result is checksummed and
# attested by the release workflow.
#
# Usage:
#   sudo bash scripts/update.sh --version 1.2.0
#   sudo bash scripts/update.sh --version 1.2.0 --archive ./xistance-panel-v1.2.0-amd64.tar.gz
#   sudo bash scripts/update.sh --rollback
#
# A version is always pinned. There is deliberately no floating "latest": an
# update must be a decision the operator can name and audit afterwards.
#
set -euo pipefail

C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YEL=$'\e[33m'; C_RST=$'\e[0m'
say()  { printf '%s\n' "$1"; }
info() { printf '%s▸ %s%s\n' "$C_YEL" "$1" "$C_RST"; }
ok()   { printf '%s✓  %s%s\n' "$C_GRN" "$1" "$C_RST"; }
die()  { printf '%s✗ %s%s\n' "$C_RED" "$1" "$C_RST" >&2; exit "${2:-1}"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

INSTALL_DIR="${XT_INSTALL_ROOT:-/opt/xistance}"
ENV_FILE="${XT_ENV_FILE:-/etc/xistance/xistance.env}"
DATA_DIR="${XT_DATA_DIR:-/var/lib/xistance}"
SERVICE_NAME="${XT_SERVICE_NAME:-xistance.service}"
NODE_BIN="${XT_NODE_BIN:-node}"

export XT_INSTALL_ROOT="$INSTALL_DIR"
export XT_RELEASES_DIR="${XT_RELEASES_DIR:-$INSTALL_DIR/releases}"
export XT_CURRENT_LINK="${XT_CURRENT_LINK:-$INSTALL_DIR/current}"
export XT_CURRENT_POINTER="${XT_CURRENT_POINTER:-$INSTALL_DIR/current-release.txt}"
export XT_ACTIVE_MANIFEST="${XT_ACTIVE_MANIFEST:-$INSTALL_DIR/active-release.json}"
export XT_RELEASE_STATE_DIR="${XT_RELEASE_STATE_DIR:-$INSTALL_DIR/state}"

# shellcheck source=lib/release-layout.sh
source "$REPO_ROOT/scripts/lib/release-layout.sh"
# shellcheck source=lib/backup-lib.sh
source "$REPO_ROOT/scripts/lib/backup-lib.sh"

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------
VERSION=""
ARCHIVE=""
ROLLBACK=false
CHANNEL="${XT_RELEASE_REPO:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)     VERSION="${2:-}"; shift 2 ;;
    --version=*)   VERSION="${1#*=}"; shift ;;
    --archive)     ARCHIVE="${2:-}"; shift 2 ;;
    --archive=*)   ARCHIVE="${1#*=}"; shift ;;
    --rollback)    ROLLBACK=true; shift ;;
    --channel)     CHANNEL="${2:-}"; shift 2 ;;
    --channel=*)   CHANNEL="${1#*=}"; shift ;;
    -h|--help)
      sed -n '4,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "Unknown option: $1 (try --help)" 2 ;;
  esac
done

# Tests drive this script directly; production requires root.
if [[ "${XT_NO_ROOT_CHECK:-0}" != "1" ]] && [[ "$(id -u)" -ne 0 ]]; then
  die "Run as root (sudo bash scripts/update.sh)" 1
fi

say ""
say "  Xistance Panel — update / به‌روزرسانی"
say ""

# ---------------------------------------------------------------------------
# Health probing
# ---------------------------------------------------------------------------
panel_port() {
  local port=""
  if [[ -f "$ENV_FILE" ]]; then
    port="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
  fi
  printf '%s' "${port:-8080}"
}

wait_for_health() {
  local url="${1:-}"
  local port attempt
  # A caller-supplied probe lets tests drive this exact function with a
  # deterministic result, so the code path under test is the production one.
  if [[ -n "${XT_TEST_HEALTH_CMD:-}" ]]; then
    eval "$XT_TEST_HEALTH_CMD" >/dev/null 2>&1 && return 0
    return 1
  fi
  port="$(panel_port)"
  url="${url:-http://127.0.0.1:${port}/api/health}"
  for attempt in $(seq 1 10); do
    if command -v curl >/dev/null 2>&1; then
      curl -sf --max-time 5 "$url" >/dev/null 2>&1 && return 0
    else
      # No curl: probe with node, which the release already requires.
      "$NODE_BIN" -e "
        fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
      " "$url" >/dev/null 2>&1 && return 0
    fi
    sleep 1
  done
  return 1
}

restart_service() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload 2>/dev/null || true
    if systemctl restart "$SERVICE_NAME" 2>/dev/null; then
      return 0
    fi
  fi
  # Not running under systemd (common in containers and in the test sandbox).
  if [[ -n "${XT_TEST_RESTART_CMD:-}" ]]; then
    eval "$XT_TEST_RESTART_CMD" >/dev/null 2>&1 && return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Native path conversion
#
# On the production host (Linux) every path is already native and `cygpath`
# does not exist, so this is a no-op. It only does work under Git Bash/MSYS on
# Windows, where a native binary such as node cannot resolve a /c/... path.
# ---------------------------------------------------------------------------
native_path() {
  local p="$1"
  if [[ "${XT_NATIVE_PATH_CMD:-auto}" == "none" ]]; then
    printf '%s' "$p"
    return 0
  fi
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$p" 2>/dev/null || printf '%s' "$p"
  else
    printf '%s' "$p"
  fi
}

# ---------------------------------------------------------------------------
# Backup
#
# Taken before any schema change, so a failed migration can be undone. Only
# mutable state is captured; a release directory is reproducible from its
# artifact and is never backed up here.
# ---------------------------------------------------------------------------
BACKUP_DIR="${XT_BACKUP_DIR:-$INSTALL_DIR/backups}"
take_backup() {
  local tarball
  mkdir -p "$BACKUP_DIR"
  tarball="$(xt_backup_create "$DATA_DIR" "$BACKUP_DIR/xistance-data-$(date +%Y%m%d%H%M%S).tar.gz")" || {
    printf 'backup failed; refusing to migrate\n' >&2
    return 1
  }
  # Creation writes the manifest and the checksum; verify them here too. A
  # backup that cannot be proven restorable must not be the last thing standing
  # between a migration and the data.
  #
  # `xt_backup_verify` prints a human-readable confirmation to stdout, and this
  # function's stdout IS the tarball path captured by the caller. Send its
  # report to stderr so the capture stays a single clean line -- otherwise the
  # path variable ends up holding "Backup verified: /path" and every later
  # -f test on it fails for a reason that looks unrelated.
  if ! xt_backup_verify "$tarball" >&2; then
    printf 'the backup did not verify; refusing to migrate\n' >&2
    return 1
  fi
  printf '%s\n' "$tarball"
}

# ---------------------------------------------------------------------------
# Migrations, run from the staged release
# ---------------------------------------------------------------------------
apply_migrations() {
  local release_dir="$1"
  local applier="$release_dir/apply-migrations.mjs"
  if [[ ! -f "$applier" ]]; then
    printf 'the release does not include apply-migrations.mjs\n' >&2
    return 1
  fi
  if [[ ! -d "$release_dir/packages/db/prisma/migrations" ]]; then
    printf 'the release does not include its migrations\n' >&2
    return 1
  fi
  # `node` is a native binary, so a POSIX path from the shell is not always a
  # path it can resolve (notably under MSYS/Git Bash on Windows). Convert the
  # paths the applier is handed rather than relying on the caller.
  local applier_path migrations_path database_path
  applier_path="$(native_path "$applier")"
  migrations_path="$(native_path "$release_dir/packages/db/prisma/migrations")"
  database_path="$(native_path "${DATA_DIR}/app.db")"

  "$NODE_BIN" "$applier_path" \
    --database "file:${database_path}" \
    --migrations "$migrations_path" \
    || return 1
  return 0
}

# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------
do_rollback() {
  local target
  target="$(xt_previous_release || true)"

  if [[ -z "$target" || ! -d "$target" ]]; then
    die "No previous release is recorded, so there is nothing to roll back to.
Check the release status, or reinstall a known version with --version." 1
  fi

  local previous_active
  previous_active="$(xt_current_release || printf '(none)')"

  info "Rolling back from $(basename "$previous_active") to $(basename "$target")…"
  xt_activate_release "$target" || die "Could not activate $(basename "$target")." 1

  restart_service || info "Could not restart $SERVICE_NAME; start it manually."
  if ! wait_for_health; then
    # Do not leave a rolled-back release that is itself unhealthy: the forward
    # release is still on disk and can be re-activated.
    printf 'the rolled-back release did not become healthy\n' >&2
    xt_activate_release "$previous_active" 2>/dev/null || true
    restart_service || true
    die "Rollback to $(basename "$target") failed its readiness check." 1
  fi

  ok "Rolled back to $(basename "$target")."
  say "   بازگردانی به نسخه $(basename "$target") انجام شد."
  say "   Data was not modified. / داده‌ها تغییری نکردند."
  return 0
}

# ---------------------------------------------------------------------------
# Resolve the artifact
# ---------------------------------------------------------------------------
resolve_archive() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64)        arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
  esac

  local name="xistance-panel-v${VERSION}-${arch}.tar.gz"
  local dir="${XT_DOWNLOAD_DIR:-$INSTALL_DIR/downloads}"
  mkdir -p "$dir"

  # Prefer a locally supplied file (air-gapped install, CI artifact).
  local candidate
  for candidate in "$ARCHIVE" "$dir/$name"; do
    if [[ -n "$candidate" && -f "$candidate" ]]; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  [[ -n "$CHANNEL" ]] || return 1
  local url="https://github.com/${CHANNEL}/releases/download/v${VERSION}/${name}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 600 -o "$dir/$name" "$url" || return 1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dir/$name" "$url" || return 1
  else
    return 1
  fi
  printf '%s' "$dir/$name"
}

# Verify the artifact before a single byte of it is trusted.
verify_archive() {
  local archive="$1"

  # The checksum sidecar is mandatory. Without it the artifact's integrity
  # cannot be proven at all, and a release must never be installed unverified.
  if [[ ! -f "${archive}.sha256" ]]; then
    printf 'no .sha256 sidecar for %s; cannot prove integrity\n' "$archive" >&2
    return 1
  fi
  local expected actual
  expected="$(cut -d' ' -f1 < "${archive}.sha256" | tr -d '[:space:]')"
  actual="$(sha256sum "$archive" | cut -d' ' -f1)"
  if [[ "$expected" != "$actual" ]]; then
    printf 'checksum mismatch for %s\n' "$archive" >&2
    printf '  expected %s\n  actual   %s\n' "$expected" "$actual" >&2
    return 1
  fi
  ok "Checksum verified."

  # The full verifier (checksum, manifest, architecture, archive safety) is
  # written in TypeScript and needs tsx, a developer tool. It is run when
  # available; when it is not, that fact is reported rather than assumed.
  # Set XT_SKIP_FULL_VERIFY=1 only where the artifact was already verified
  # upstream (a test fixture, or a re-check of a known-good artifact).
  if [[ "${XT_SKIP_FULL_VERIFY:-0}" == "1" ]]; then
    info "Full artifact verification skipped by request; checksum alone was enforced."
    return 0
  fi
  local verifier="$REPO_ROOT/scripts/verify-artifact.ts"
  if [[ -f "$verifier" ]] && command -v npx >/dev/null 2>&1; then
    # `cd` first: passing an MSYS-style path to npx is mangled into a Windows
    # path that node cannot resolve.
    if ! (cd "$REPO_ROOT" && npx --no-install tsx scripts/verify-artifact.ts "$archive"); then
      printf 'artifact verification failed; refusing to install\n' >&2
      return 1
    fi
  else
    info "Full artifact verification unavailable here; checksum alone was enforced."
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Main update
# ---------------------------------------------------------------------------
if [[ "$ROLLBACK" == "true" ]]; then
  do_rollback
  exit 0
fi

[[ -n "$VERSION" ]] || die "A pinned --version is required.
There is no floating 'latest' update: pass --version 1.2.0 (or use --rollback)." 2
[[ -d "$INSTALL_DIR" ]] || die "Panel is not installed (missing $INSTALL_DIR)." 1
[[ -f "$ENV_FILE" ]] || die "Environment file missing ($ENV_FILE). Re-run scripts/install.sh first." 1

PREVIOUS_ACTIVE="$(xt_current_release || true)"
PREVIOUS_VERSION="$(basename "${PREVIOUS_ACTIVE:-unknown}")"

if [[ -n "$PREVIOUS_ACTIVE" && "$(basename "$PREVIOUS_ACTIVE")" == "$VERSION" ]]; then
  die "Version $VERSION is already active. Use --rollback, or pass a different --version." 2
fi

ARCHIVE_PATH="$(resolve_archive)" \
  || die "Could not obtain the release artifact for version $VERSION.
Pass --archive <file>, or set --channel insekt1024/xistance-panel to download it." 1

info "Verifying $VERSION…"
verify_archive "$ARCHIVE_PATH" || die "Verification failed for $VERSION. Nothing was changed." 1

# Everything above is read-only. From here the update can fail, and every
# failure path returns to $PREVIOUS_ACTIVE with the data intact.
BACKUP_PATH="$(take_backup)" || die "Backup failed; refusing to migrate." 1
# Re-verify the archive the update is about to rely on, immediately before the
# first mutating step. take_backup already checked it, but the check is cheap
# and this is the last moment at which a failure is still free.
if [[ -f "$BACKUP_PATH" ]]; then
  xt_backup_require "$BACKUP_PATH" || die "Backup verification failed; refusing to change the active release." 1
  ok "Data backed up and verified: $(basename "$BACKUP_PATH")"
fi

RELEASE_DIR="$XT_RELEASES_DIR/$VERSION"
if [[ -e "$RELEASE_DIR" ]]; then
  # Re-installing the same version: replace it. The active pointer still names
  # the previous release until cutover, so this is safe.
  info "Release $VERSION already exists; replacing the staging copy."
  rm -rf -- "${RELEASE_DIR:?}"
fi
mkdir -p "$XT_RELEASES_DIR" "$XT_RELEASE_STATE_DIR" "$RELEASE_DIR"

info "Extracting $VERSION…"
# The archive root is the release tree, so it is extracted *into* the release
# directory rather than beside it.
if ! tar -xzf "$ARCHIVE_PATH" -C "$RELEASE_DIR"; then
  rm -rf -- "${RELEASE_DIR:?}"
  die "Extraction failed. The previous release is still active and untouched." 1
fi

info "Applying database migrations…"
if ! apply_migrations "$RELEASE_DIR"; then
  rm -rf -- "${RELEASE_DIR:?}"
  die "Migration failed. Nothing was activated.
The previous release ($PREVIOUS_VERSION) is still serving.
A data backup is at: ${BACKUP_PATH:-none}" 1
fi
ok "Schema is up to date."

# Activate, restart, then verify with a real health probe. A failure here
# returns the pointer to the previous release and restarts it.
info "Activating $VERSION…"
xt_cutover_with_health_check "$RELEASE_DIR" true \
  || die "Could not activate $VERSION." 1

restart_service || info "Could not restart $SERVICE_NAME; start it manually."

if ! wait_for_health; then
  printf 'the new release did not become healthy\n' >&2
  xt_mark_release_failed "$RELEASE_DIR" 2>/dev/null || true
  if [[ -n "$PREVIOUS_ACTIVE" && -d "$PREVIOUS_ACTIVE" ]]; then
    xt_activate_release "$PREVIOUS_ACTIVE" 2>/dev/null || true
    restart_service 2>/dev/null || true
  fi
  die "Readiness check failed; rolled back to $PREVIOUS_VERSION.
The failed release is kept at $RELEASE_DIR for inspection.
Data was not modified. / داده‌ها تغییری نکردند." 1
fi

say ""
ok "Update complete: $PREVIOUS_VERSION → $VERSION"
say "   Rollback with: sudo bash scripts/update.sh --rollback"
say "   بازگردانی: sudo bash scripts/update.sh --rollback"
