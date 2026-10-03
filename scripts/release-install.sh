#!/usr/bin/env bash
#
# Xistance Panel — release-install.sh
#
# One-line, version-pinned, zero-build installer. Downloads a *prebuilt*
# release artifact for the host architecture, verifies it, deploys it into an
# immutable versioned release directory, activates it, and health-checks the
# result.
#
# This script never builds the panel. It does not run `npm ci`, `npm install`,
# `next build`, or Prisma generation. The target host only needs curl, tar and
# a Node.js runtime that the artifact already declares.
#
# One-liner (see README for the current version):
#   curl -fsSL https://raw.githubusercontent.com/insekt1024/xistance-panel/<TAG>/scripts/bootstrap.sh \
#     -o /tmp/xp-install.sh && sudo bash /tmp/xp-install.sh --release --version <TAG>
#
set -uo pipefail

C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YEL=$'\e[33m'; C_RST=$'\e[0m'

VERSION=""
ARCH=""
INSTALL_DIR="${XT_INSTALL_DIR:-/opt/xistance}"
DATA_DIR="${XT_DATA_DIR:-/var/lib/xistance}"
ETC_DIR="${XT_ETC_DIR:-/etc/xistance}"
ENV_FILE=""
DRY_RUN=0
LOCAL_ARCHIVE=""
MANIFEST_FROM_ARCHIVE=0
KEEP_DOWNLOAD=0
REPO_SLUG="${XT_REPO_SLUG:-insekt1024/xistance-panel}"
GH_BASE="${XT_MIRROR:-https://github.com}"
GH_BASE="${GH_BASE%/}"
NODE_MIN_MAJOR=22

usage() {
  cat <<EOF
Xistance Panel — version-pinned release installer

Usage:
  release-install.sh --version <TAG> [options]

Required:
  --version <TAG>       Release tag to install, e.g. v1.2.0. There is no
                        "latest" default on purpose: an unpinned install is
                        not reproducible.

Options:
  --arch <ARCH>         Override architecture detection (amd64 | arm64).
  --install-dir <DIR>   Release root (default: /opt/xistance)
  --data-dir <DIR>      Mutable data/logs/binaries (default: /var/lib/xistance)
  --etc-dir <DIR>       Config directory (default: /etc/xistance)
  --env-file <FILE>     Environment file path (default: <etc-dir>/xistance.env)
  --repo <SLUG>         GitHub repo slug (default: $REPO_SLUG)
  --archive <FILE>      Install a pre-downloaded artifact instead of fetching
                        one from GitHub. Its .sha256 sidecar must sit beside
                        it. Use this for air-gapped hosts.
  --dry-run             Print the plan and exit without changing anything.
  --keep-download       Keep the downloaded artifact for inspection.
  -h, --help            Show this help.

This installer does not build from source. It installs a prebuilt artifact.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2;;
    --version=*) VERSION="${1#*=}"; shift;;
    --arch) ARCH="${2:-}"; shift 2;;
    --arch=*) ARCH="${1#*=}"; shift;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2;;
    --install-dir=*) INSTALL_DIR="${1#*=}"; shift;;
    --data-dir) DATA_DIR="${2:-}"; shift 2;;
    --data-dir=*) DATA_DIR="${1#*=}"; shift;;
    --etc-dir) ETC_DIR="${2:-}"; shift 2;;
    --etc-dir=*) ETC_DIR="${1#*=}"; shift;;
    --env-file) ENV_FILE="${2:-}"; shift 2;;
    --env-file=*) ENV_FILE="${1#*=}"; shift;;
    --repo) REPO_SLUG="${2:-}"; shift 2;;
    --repo=*) REPO_SLUG="${1#*=}"; shift;;
    --archive) LOCAL_ARCHIVE="${2:-}"; shift 2;;
    --archive=*) LOCAL_ARCHIVE="${1#*=}"; shift;;
    --dry-run) DRY_RUN=1; shift;;
    --keep-download) KEEP_DOWNLOAD=1; shift;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2;;
  esac
done


say()  { printf '%s\n' "$1"; }
info() { printf '%s→ %s%s\n' "$C_YEL" "$1" "$C_RST"; }
ok()   { printf '%s✓ %s%s\n' "$C_GRN" "$1" "$C_RST"; }
die()  { printf '%s✗ %s%s\n' "$C_RED" "$1" "$C_RST" >&2; exit "${2:-1}"; }

[[ -n "$ENV_FILE" ]] || ENV_FILE="${ETC_DIR}/xistance.env"

# ---------------------------------------------------------------------------
# Fixture mode
#
# XT_FIXTURE=1 makes host mutation structurally impossible rather than merely
# skipped: the systemd and useradd paths return early, and any attempt to point
# the installer at a real system directory is refused. This exists so the CLI
# can be regression-tested without root, without systemd, and without writing to
# /opt or /etc — a test that quietly reuses production paths would eventually
# damage the machine it runs on.
# ---------------------------------------------------------------------------
FIXTURE_MODE="${XT_FIXTURE:-0}"
if [[ "$FIXTURE_MODE" == "1" ]]; then
  if [[ "$(id -u)" -eq 0 ]]; then
    die "Refusing to run in fixture mode as root: a test must never be able to
write to the real /opt or /etc. Run the suite as an unprivileged user." 2
  fi
  for guard in "$INSTALL_DIR" "$DATA_DIR" "$ETC_DIR"; do
    case "$guard" in
      /opt|/opt/*|/etc|/etc/*|/var|/var/*|/usr|/usr/*)
        die "Refusing system path '$guard' in fixture mode; use a temporary directory." 2
        ;;
    esac
  done
fi


# ---------------------------------------------------------------------------
# A pinned version is mandatory. Refusing an implicit "latest" is what makes an
# install reproducible months later.
# ---------------------------------------------------------------------------
if [[ -z "$VERSION" ]]; then
  die "--version is required. An unpinned install is not reproducible.
Pass an explicit release tag, for example: --version v1.2.0" 2
fi
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "Invalid version '$VERSION'. Expected an explicit semver tag such as v1.2.0." 2
fi

# ---------------------------------------------------------------------------
# Architecture
# ---------------------------------------------------------------------------
detect_arch() {
  local machine
  machine="$(uname -m 2>/dev/null || echo unknown)"
  case "$machine" in
    x86_64|amd64) printf 'amd64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *) printf 'unsupported:%s' "$machine" ;;
  esac
}

if [[ -z "$ARCH" ]]; then
  ARCH="$(detect_arch)"
fi
if [[ "$ARCH" == unsupported:* ]]; then
  die "Unsupported architecture: ${ARCH#unsupported:}.
This release ships prebuilt artifacts for amd64 and arm64 only." 3
fi
if [[ "$ARCH" != "amd64" && "$ARCH" != "arm64" ]]; then
  die "Unsupported architecture: $ARCH. Use --arch amd64 or --arch arm64." 3
fi

# ---------------------------------------------------------------------------
# OS support
# ---------------------------------------------------------------------------
check_os() {
  [[ -r /etc/os-release ]] || return 0
  local id="" version_id=""
  # shellcheck disable=SC1091
  # NOTE: /etc/os-release defines a variable literally named VERSION. Sourcing
  # it here overwrote the release VERSION being installed, so the installer
  # reported "Installing 24.04.1 LTS" and built release paths from it. Source it
  # into a subshell-free but name-safe scope: read the two fields we need via a
  # child shell so nothing leaks into this script's namespace.
  id="$( . /etc/os-release 2>/dev/null >/dev/null; printf '%s' "${ID:-}" )"
  version_id="$( . /etc/os-release 2>/dev/null >/dev/null; printf '%s' "${VERSION_ID:-}" )"
  case "$id" in
    ubuntu)
      case "$version_id" in
        22.04|24.04) return 0 ;;
        *) die "Unsupported Ubuntu release: $version_id. Supported: 22.04, 24.04." 3 ;;
      esac
      ;;
    debian)
      say "Debian detected; proceeding on a best-effort basis."
      ;;
    *)
      say "Unrecognised distribution; proceeding on a best-effort basis."
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------
RELEASE_DIR_NAME="$VERSION"
RELEASES_DIR="${INSTALL_DIR}/releases"
CANDIDATE_DIR="${RELEASES_DIR}/${RELEASE_DIR_NAME}"
ARCHIVE_NAME="xistance-panel-${VERSION}-${ARCH}.tar.gz"
DOWNLOAD_BASE="${GH_BASE}/${REPO_SLUG}/releases/download/${VERSION}"
ARCHIVE_URL="${DOWNLOAD_BASE}/${ARCHIVE_NAME}"
CHECKSUM_URL="${DOWNLOAD_BASE}/${ARCHIVE_NAME}.sha256"
MANIFEST_URL="${DOWNLOAD_BASE}/release-manifest.json"

print_plan() {
  say "Xistance Panel release installer (dry run)"
  say "  version      : ${VERSION}"
  say "  architecture : ${ARCH}"
  say "  install dir  : ${INSTALL_DIR}"
  say "  release dir  : ${CANDIDATE_DIR}"
  say "  data dir     : ${DATA_DIR}"
  say "  env file     : ${ENV_FILE}"
  if [[ -n "$LOCAL_ARCHIVE" ]]; then
    say "  archive      : ${LOCAL_ARCHIVE} (local)"
  else
    say "  archive      : ${ARCHIVE_URL}"
  fi
  say "  checksum     : ${CHECKSUM_URL}"
  say "  source build : none (prebuilt artifact)"
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  print_plan
  exit 0
fi

# ---------------------------------------------------------------------------
# Root + prerequisites
# ---------------------------------------------------------------------------
# A real install writes to /opt, /etc and /var, so it requires root. Fixture
# mode writes only inside a caller-supplied temporary directory, so requiring
# root there would make the CLI untestable without sudo.
if [[ "$(id -u)" -ne 0 && "$FIXTURE_MODE" != "1" ]]; then
  die "Run as root (sudo bash release-install.sh --version ${VERSION})." 4
fi
if command -v curl >/dev/null 2>&1; then
  :
else
  # curl is only used to download; a caller that already staged the artifact
  # does not need it, and fixture tests never reach the network.
  if [[ "$FIXTURE_MODE" != "1" ]]; then
    die "curl is required." 4
  fi
fi
command -v tar  >/dev/null 2>&1 || die "tar is required." 4
check_os

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  die "Node.js ${NODE_MIN_MAJOR}+ is required by this release but was not found.
Install Node.js ${NODE_MIN_MAJOR} (for example via nodesource) and re-run." 4
fi
node_major="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$node_major" -lt "$NODE_MIN_MAJOR" ]]; then
  die "Node.js ${NODE_MIN_MAJOR}+ is required; found major version ${node_major}." 4
fi

info "Installing Xistance Panel ${VERSION} (${ARCH})"
print_plan

# ---------------------------------------------------------------------------
# Layout helpers from the same pinned tag
# ---------------------------------------------------------------------------
LIB_URL="${GH_BASE}/${REPO_SLUG}/raw/${VERSION}/scripts/lib/release-layout.sh"
UNIT_LIB_URL="${GH_BASE}/${REPO_SLUG}/raw/${VERSION}/scripts/lib/service-unit.sh"
VERIFY_URL="${GH_BASE}/${REPO_SLUG}/raw/${VERSION}/scripts/verify-artifact.ts"
MANIFEST_TOOL_URL="${GH_BASE}/${REPO_SLUG}/raw/${VERSION}/scripts/release-manifest.ts"

# Directory holding this script, so a local (non-downloaded) install can find
# the libraries beside it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORK_DIR="$(mktemp -d /tmp/xistance-release.XXXXXX)"
cleanup() {
  if [[ "$KEEP_DOWNLOAD" -eq 0 ]]; then
    rm -rf -- "$WORK_DIR"
  else
    printf 'Downloaded files kept at %s\n' "$WORK_DIR"
  fi
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Download artifact, checksum and manifest to a temp directory
# ---------------------------------------------------------------------------
ARCHIVE_PATH="${WORK_DIR}/${ARCHIVE_NAME}"
CHECKSUM_PATH="${WORK_DIR}/${ARCHIVE_NAME}.sha256"
MANIFEST_PATH="${WORK_DIR}/release-manifest.json"

# With --archive the artifact (and its sidecars) are already on this host, so
# nothing is downloaded. This is the air-gapped and CI-artifact path, and it is
# how the installer is exercised before any GitHub release exists.
if [[ -n "$LOCAL_ARCHIVE" ]]; then
  [[ -f "$LOCAL_ARCHIVE" ]] \
    || die "The given --archive does not exist: ${LOCAL_ARCHIVE}" 5
  info "Using the local artifact ${LOCAL_ARCHIVE}…"
  cp -f -- "$LOCAL_ARCHIVE" "$ARCHIVE_PATH" \
    || die "Could not read the given artifact." 5
  # The sidecars travel with the archive; a missing one is fatal below, because
  # an artifact whose integrity cannot be proven must never be installed.
  if [[ -f "${LOCAL_ARCHIVE}.sha256" ]]; then
    cp -f -- "${LOCAL_ARCHIVE}.sha256" "$CHECKSUM_PATH"
  fi
  # The manifest travels inside the archive, so it is taken from there.
  MANIFEST_FROM_ARCHIVE=1
else
  info "Downloading artifact…"
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 \
    -o "$ARCHIVE_PATH" "$ARCHIVE_URL" \
    || die "Download failed: ${ARCHIVE_URL}
Check that release ${VERSION} has a prebuilt artifact for ${ARCH}." 5

  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 \
    -o "$CHECKSUM_PATH" "$CHECKSUM_URL" \
    || die "Checksum download failed: ${CHECKSUM_URL}
A release without a checksum cannot be installed safely." 5

  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 \
    -o "$MANIFEST_PATH" "$MANIFEST_URL" \
    || die "Manifest download failed: ${MANIFEST_URL}
A release without a manifest cannot be verified." 5
fi

# ---------------------------------------------------------------------------
# Verify before extraction. The active release is not touched before this
# passes.
# ---------------------------------------------------------------------------
info "Verifying artifact…"
# The verification tooling is plain TypeScript run through the repo's tsx
# dependency, but the artifact ships without node_modules for the scripts, so
# The checksum sidecar is mandatory. Without it the artifact's integrity cannot
# be proven at all, so a missing sidecar is fatal rather than a warning.
if [[ ! -f "$CHECKSUM_PATH" ]]; then
  die "No checksum sidecar for ${ARCHIVE_NAME}.
A release whose integrity cannot be proven must never be installed." 6
fi

# In local mode the manifest travels inside the archive, so it is lifted out
# before the archive is extracted into the release directory.
if [[ "$MANIFEST_FROM_ARCHIVE" -eq 1 ]]; then
  # The archive is created with `tar -C dir .`, so members are stored as
  # "./release-manifest.json". Matching on the exact name fails on that form,
  # so the leading "./" is matched explicitly.
  if ! tar -xzf "$ARCHIVE_PATH" -C "$WORK_DIR" ./release-manifest.json 2>/dev/null; then
    die "The artifact does not contain release-manifest.json.
A release without a manifest cannot be verified." 6
  fi
  ok "Manifest taken from the artifact."
fi

# use the pinned sources when available and fall back to sha256sum otherwise.
VERIFIED=0
if curl -fsL --connect-timeout 15 -o "${WORK_DIR}/verify-artifact.ts" "$VERIFY_URL" 2>/dev/null \
   && curl -fsL --connect-timeout 15 -o "${WORK_DIR}/release-manifest.ts" "$MANIFEST_TOOL_URL" 2>/dev/null; then
  if command -v npx >/dev/null 2>&1; then
    if ( cd "$WORK_DIR" && npx --yes tsx verify-artifact.ts verify \
           --artifact "$ARCHIVE_PATH" --checksum "$CHECKSUM_PATH" \
           --manifest "$MANIFEST_PATH" --version "$VERSION" --arch "$ARCH" ) 2>/dev/null; then
      VERIFIED=1
    fi
  fi
fi

if [[ "$VERIFIED" -ne 1 ]]; then
  # Fallback: verify the published digest with the system tool. This still
  # refuses to extract a tampered artifact; it cannot additionally check the
  # manifest, so that is reported honestly.
  if command -v sha256sum >/dev/null 2>&1; then
    ( cd "$WORK_DIR" && sha256sum --check --status "${ARCHIVE_NAME}.sha256" ) \
      || die "Checksum verification FAILED for ${ARCHIVE_NAME}.
The download does not match the published digest. Not extracting." 6
    ok "Checksum verified (sha256sum)."
  else
    die "No checksum tool available (need sha256sum or npx tsx). Refusing to install unverified." 6
  fi
else
  ok "Artifact verified (checksum + manifest)."
fi

# ---------------------------------------------------------------------------
# Deploy into an immutable versioned directory
# ---------------------------------------------------------------------------
if [[ -n "$LOCAL_ARCHIVE" ]]; then
  # A local install ships the libraries beside this script, or they are taken
  # from the artifact itself. Nothing is fetched.
  # The libraries are looked for beside the script, then in ./lib next to it.
  # A one-line installer is often fetched and run from /root or a home
  # directory, where the repository's scripts/lib layout does not exist, so the
  # release ships them alongside and both layouts are accepted.
  LIB_SRC_DIR=""
  for candidate in "$SCRIPT_DIR/lib" "$REPO_ROOT/scripts/lib" "$SCRIPT_DIR"; do
    if [[ -f "$candidate/release-layout.sh" && -f "$candidate/service-unit.sh" ]]; then
      LIB_SRC_DIR="$candidate"
      break
    fi
  done
  [[ -n "$LIB_SRC_DIR" ]] \
    || die "Could not find release-layout.sh and service-unit.sh.
Looked beside this script and in ./lib. Fetch them from the same release tag." 7
  cp -f -- "$LIB_SRC_DIR/release-layout.sh" "${WORK_DIR}/release-layout.sh"
  cp -f -- "$LIB_SRC_DIR/service-unit.sh" "${WORK_DIR}/service-unit.sh"
else
  curl -fsL --connect-timeout 15 -o "${WORK_DIR}/release-layout.sh" "$LIB_URL" 2>/dev/null \
    || die "Could not obtain the release layout library for ${VERSION}." 7
  curl -fsL --connect-timeout 15 -o "${WORK_DIR}/service-unit.sh" "$UNIT_LIB_URL" 2>/dev/null \
    || die "Could not obtain the systemd unit library for ${VERSION}." 7
fi
# shellcheck source=lib/release-layout.sh
source "${WORK_DIR}/release-layout.sh"
# shellcheck source=lib/service-unit.sh
source "${WORK_DIR}/service-unit.sh"

# The panel serves a web UI and spawns tunnel binaries. It does not need root,
# and running it as root would turn any code-execution bug into a full
# compromise. The account owns the mutable data directory and nothing else.
SERVICE_USER="${XT_SERVICE_USER:-xistance}"

export XT_INSTALL_ROOT="$INSTALL_DIR"
export XT_RELEASES_DIR="$RELEASES_DIR"
export XT_CURRENT_LINK="${INSTALL_DIR}/current"
export XT_CURRENT_POINTER="${INSTALL_DIR}/current-release.txt"
export XT_ACTIVE_MANIFEST="${INSTALL_DIR}/active-release.json"
export XT_RELEASE_STATE_DIR="${INSTALL_DIR}/state"

mkdir -p "$RELEASES_DIR" "$XT_RELEASE_STATE_DIR" "$DATA_DIR" "$ETC_DIR"

# ---------------------------------------------------------------------------
# Service account
#
# The unit runs unprivileged, so the account must exist and must own the one
# directory that is written at runtime. Releases stay root-owned and read-only:
# the service can execute them but cannot modify them.
# ---------------------------------------------------------------------------
if [[ "$FIXTURE_MODE" == "1" ]]; then
  info "Fixture mode: not creating a service account."
elif [[ "$(id -u)" -eq 0 ]] && command -v useradd >/dev/null 2>&1; then
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
      || die "Could not create the service account ${SERVICE_USER}." 9
    ok "Created service account ${SERVICE_USER}."
  fi
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR" 2>/dev/null \
    || die "Could not give ${SERVICE_USER} ownership of ${DATA_DIR}." 9
  # world-readable/traversable so the service can read the release tree, but
  # not writable, so a compromised service cannot replace its own code.
  chmod 0755 "$INSTALL_DIR" "$RELEASES_DIR" 2>/dev/null || true
else
  info "Not creating a service account (needs root + useradd); the unit will run as ${SERVICE_USER}."
fi

PREVIOUS_ACTIVE="$(xt_current_release 2>/dev/null || true)"

# An existing directory for this version means a re-install of the same tag.
# Never mutate a published release: deploy beside it under a distinct name.
if [[ -e "$CANDIDATE_DIR" ]]; then
  CANDIDATE_DIR="${RELEASES_DIR}/${RELEASE_DIR_NAME}-$(date +%Y%m%d%H%M%S)"
  info "Release ${VERSION} is already installed; deploying as $(basename "$CANDIDATE_DIR")."
fi
mkdir -p "$CANDIDATE_DIR" || die "Could not create release directory ${CANDIDATE_DIR}." 7

info "Extracting into ${CANDIDATE_DIR}…"
tar -xzf "$ARCHIVE_PATH" -C "$CANDIDATE_DIR" \
  || { rm -rf -- "$CANDIDATE_DIR"; die "Extraction failed; the previous release is untouched." 7; }

if [[ ! -f "$CANDIDATE_DIR/apps/web/server.js" ]]; then
  rm -rf -- "$CANDIDATE_DIR"
  die "The artifact does not contain apps/web/server.js; refusing to activate it." 7
fi

# ---------------------------------------------------------------------------
# Apply database migrations.
#
# The artifact ships the Prisma client but not the Prisma CLI, so
# `prisma migrate deploy` is unavailable here. The staged applier uses
# node:sqlite to run the same SQL. It is idempotent and refuses to continue if
# the database and the artifact disagree about a migration's checksum.
# ---------------------------------------------------------------------------
if [[ -f "$CANDIDATE_DIR/apply-migrations.mjs" ]]; then
  info "Applying database migrations…"
  MIGRATION_DB="${DATA_DIR}/app.db"
  "$NODE_BIN" "$CANDIDATE_DIR/apply-migrations.mjs" \
    --database "file:${MIGRATION_DB}" \
    --migrations "$CANDIDATE_DIR/packages/db/prisma/migrations" \
    || die "Database migration failed. The release was not activated." 7
  # The migration runs as the installing user (root on a real install) and
  # CREATES the database, so the `chown -R` performed earlier - while the data
  # dir was still empty - does not cover it. On a FIRST install the file is
  # left owned by root, and the service user can read the schema (so
  # /api/health answers 200) while every write fails with "attempt to write a
  # readonly database". Hand ownership over after the file exists.
  if [[ "$(id -u)" -eq 0 ]] && id -u "$SERVICE_USER" >/dev/null 2>&1; then
    chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR" 2>/dev/null \
      || die "Could not give ${SERVICE_USER} ownership of ${DATA_DIR}." 9
  fi
  ok "Database schema is up to date."
else
  die "The artifact does not include apply-migrations.mjs; refusing to activate
a release whose database cannot be migrated." 7
fi

# ---------------------------------------------------------------------------
# Create the initial super-admin.
#
# seed.ts is TypeScript and imports the Prisma client, so it is not in the
# artifact. This script uses the same scrypt scheme the app verifies against.
# The password is generated here and shown once; an existing admin is never
# overwritten, so re-running the installer does not rotate a live credential.
# ---------------------------------------------------------------------------
ADMIN_EMAIL="${XT_ADMIN_EMAIL:-admin@xistance.local}"
if [[ ! -f "$CANDIDATE_DIR/create-admin.mjs" ]]; then
  die "The artifact does not include create-admin.mjs; refusing to activate a
release with no way to create the first account." 7
fi

ADMIN_PASSWORD="${XT_ADMIN_PASSWORD:-}"
GENERATED_ADMIN_PASSWORD=0
if [[ -z "$ADMIN_PASSWORD" ]]; then
  ADMIN_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -d '=+/' | head -c 20)"
  GENERATED_ADMIN_PASSWORD=1
fi

info "Ensuring an administrator account exists…"
# Capture the creator's output so the password is printed only when the account
# was genuinely created by this run.
ADMIN_OUTPUT="$("$NODE_BIN" "$CANDIDATE_DIR/create-admin.mjs" \
  --database "file:${DATA_DIR}/app.db" \
  --email "$ADMIN_EMAIL" \
  --password "$ADMIN_PASSWORD")" \
  || die "Could not create the administrator account." 7
printf '%s\n' "$ADMIN_OUTPUT"

if [[ "$GENERATED_ADMIN_PASSWORD" -eq 1 ]] && printf '%s' "$ADMIN_OUTPUT" | grep -q "created super admin"; then
  say ""
  printf '%s%s%s\n' "$C_YEL" "  Admin email:    $ADMIN_EMAIL" "$C_RST"
  printf '%s%s%s\n' "$C_YEL" "  Admin password: $ADMIN_PASSWORD" "$C_RST"
  say "  Save it now — it is not shown again. / هم‌اکنون ذخیره کنید."
  say ""
fi

# Mutable state must not live inside a release.
cp -f /var/lib/xistance/forwarder-runner.ts "$DATA_DIR/forwarder-runner.ts" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Environment file: create a minimal one if absent, never overwrite a real one.
# ---------------------------------------------------------------------------
if [[ ! -f "$ENV_FILE" ]]; then
  info "Creating ${ENV_FILE}"
  mkdir -p "$ETC_DIR"
  JWT_SECRET_GENERATED="$(head -c 48 /dev/urandom | base64 | tr -d '=+/' | head -c 48)"
  cat > "$ENV_FILE" <<EOF
# Xistance Panel environment. Keep this file readable only by root.
NODE_ENV=production
PORT=8080
HOSTNAME=0.0.0.0
XT_DATA_DIR=${DATA_DIR}
XT_ETC_DIR=${ETC_DIR}
DATABASE_URL=file:${DATA_DIR}/app.db
JWT_SECRET=${JWT_SECRET_GENERATED}
EOF
  chmod 600 "$ENV_FILE" 2>/dev/null || true
else
  info "Reusing existing ${ENV_FILE}"
fi

# ---------------------------------------------------------------------------
# Rollback helper
# ---------------------------------------------------------------------------
# Installed as a REAL command on PATH.
#
# Previously the only rollback instruction was `xt_activate_release <dir>`,
# which is a shell function sourced from lib/release-layout.sh. Nothing put it
# on PATH, so the documented recovery command failed with "command not found"
# on a real Ubuntu host (verified on 22.04 amd64). An operator rolling back a
# bad upgrade had no working command at all.
#
# The wrapper also restarts the unit. xt_activate_release only moves the
# pointer file and symlink, so invoking it left the old process serving the old
# code while the panel reported the new release as active.
#
# DEFINED BEFORE IT IS CALLED. This function used to be defined ~15 lines
# AFTER its call site, inside an unfinished `if` block, so bash reported
# "xt_install_rollback_command: command not found" and the helper was silently
# never installed — while the installer still exited 0 and reported success.
# A function must be defined before the point where it is invoked.
xt_install_rollback_command() {
  # The install location is overridable so this can be exercised without root
  # (the installer suite runs the real function against a temp dir). The default
  # is the operator-facing path both READMEs document.
  local target="${XT_ROLLBACK_COMMAND_PATH:-/usr/local/bin/xt-rollback}"
  # The library is staged at ${WORK_DIR}/release-layout.sh (sourced at line ~408),
  # NOT under a lib/ subdirectory. The earlier path here was
  # "$WORK_DIR/lib/release-layout.sh", so `[[ -r ]]` failed, the function
  # returned 1, and the helper was silently never installed -- the installer
  # still exited 0 and printed a rollback hint naming a command that did not
  # exist. Resolve the real location, with a lib/ fallback for safety.
  local src=""
  if [[ -r "${WORK_DIR}/release-layout.sh" ]]; then
    src="${WORK_DIR}/release-layout.sh"
  elif [[ -r "${WORK_DIR}/lib/release-layout.sh" ]]; then
    src="${WORK_DIR}/lib/release-layout.sh"
  else
    return 1
  fi
  # WORK_DIR is a mktemp -d that the installer removes on exit, so a wrapper
  # that sources it dies the moment it is actually needed ("No such file or
  # directory") -- verified on Ubuntu 22.04 amd64. Install a PRIVATE copy next
  # to the command and source that instead, so the command is self-contained
  # and survives the installer finishing.
  local installed_lib="${target}.lib"
  cp -f -- "$src" "$installed_lib" || return 1
  chmod 0644 "$installed_lib" || return 1
  {
    printf '#!/usr/bin/env bash\n'
    printf '# Generated by release-install.sh. Rolls the panel back to a previous\n'
    printf '# release and RESTARTS the service, so the old process stops serving.\n'
    printf '#\n'
    printf '# The library is installed alongside this command, NOT sourced from the\n'
    printf '# installer temp dir: that directory is removed on exit, so a wrapper\n'
    printf '# pointing at it fails every time an operator needs to roll back.\n'
    printf 'set -euo pipefail\n'
    printf 'XT_ROLLBACK_LIB="%s"\n' "$installed_lib"
    printf '[[ -r "$XT_ROLLBACK_LIB" ]] || { echo "xt-rollback: missing $XT_ROLLBACK_LIB (re-run the installer)" >&2; exit 1; }\n'
    printf '. "$XT_ROLLBACK_LIB"\n'
    printf 'xt_rollback "$@"\n'
  } > "$target" || return 1
  chmod 0755 "$target" || return 1
}

# ---------------------------------------------------------------------------
# systemd unit resolved through the active pointer
# ---------------------------------------------------------------------------
# The unit is rendered through the shared library so every value is sanitised
# and quoted, and so the template cannot drift between the two installers.
UNIT_SRC="${TMP_DIR:-/tmp}/xistance-unit.$$"
if [[ "$FIXTURE_MODE" == "1" ]]; then
  # Fixture mode still renders the unit — so a broken renderer is caught — but
  # never installs it. Writing to /etc/systemd/system is the one action a test
  # must never perform.
  if xt_render_service_unit "$ENV_FILE" "${INSTALL_DIR}/current" "$NODE_BIN" \
       "$SERVICE_USER" > "$UNIT_SRC"; then
    ok "Fixture mode: unit rendered but not installed."
    rm -f -- "$UNIT_SRC"
  else
    die "Could not render a safe systemd unit; refusing to continue." 9
  fi
elif xt_render_service_unit "$ENV_FILE" "${INSTALL_DIR}/current" "$NODE_BIN" \
     "$SERVICE_USER" > "$UNIT_SRC"; then
  if xt_install_service "$UNIT_SRC" /etc/systemd/system/xistance.service; then
    ok "Systemd unit installed for ${SERVICE_USER}."

    # The rollback helper is defined further down (functions are hoisted at call
    # time in bash, but only once the definition has been executed). It MUST be
    # called after its definition, so it lives here as a call and the body is at
    # the bottom of this file.
    if xt_install_rollback_command; then
      ok "Rollback helper installed at /usr/local/bin/xt-rollback"
    fi
  else
    # Surfaced, not swallowed: a unit systemd did not accept would otherwise be
    # reported as a successful install while the service never starts.
    die "The systemd unit was not installed; the panel will not start on boot." 9
  fi
  rm -f -- "$UNIT_SRC"
else
  die "Could not render a safe systemd unit; refusing to write one." 9
fi

# ---------------------------------------------------------------------------
# Activate, then verify readiness. A failed readiness check rolls the pointer
# back to the release that was active before.
# ---------------------------------------------------------------------------
info "Activating $(basename "$CANDIDATE_DIR")…"
xt_activate_release "$CANDIDATE_DIR" \
  || { rm -rf -- "$CANDIDATE_DIR"; die "Could not activate ${CANDIDATE_DIR}." 8; }

if [[ "$FIXTURE_MODE" == "1" ]]; then
  info "Fixture mode: not restarting any service."
elif command -v systemctl >/dev/null 2>&1; then
  systemctl restart xistance.service 2>/dev/null \
    || info "Could not restart xistance.service; start it manually."
fi

PANEL_PORT="8080"
if [[ -f "$ENV_FILE" ]]; then
  set -a; . "$ENV_FILE" 2>/dev/null; set +a
  PANEL_PORT="${PORT:-$PANEL_PORT}"
fi

ready=false
# XT_TEST_HEALTH_CMD lets a fixture drive the readiness result deterministically
# instead of waiting on a server it did not start. Absent it, the real HTTP
# probe below is used unchanged.
if [[ -n "${XT_TEST_HEALTH_CMD:-}" ]]; then
  if eval "$XT_TEST_HEALTH_CMD" >/dev/null 2>&1; then ready=true; fi
else
  for _attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    sleep 1
    if curl -sf --max-time 5 "http://127.0.0.1:${PANEL_PORT}/api/health" >/dev/null 2>&1; then
      ready=true
      break
    fi
  done
fi

if [[ "$ready" != "true" ]]; then
  # Say WHY. Found on arm64: the install reached migrations, admin bootstrap and
  # a installed systemd unit, then reported only "Readiness check failed" with
  # no cause -- so the first native-arm64 install failure had to be diagnosed by
  # re-running it. On a cold start the panel answers in ~1s locally, so a
  # timeout this early is a real failure, not slowness, and the operator is
  # left with nothing to act on.
  #
  # Best-effort: never let diagnostics mask the original failure.
  if command -v systemctl >/dev/null 2>&1; then
    # Walk the WorkingDirectory path component by component. systemd reports only
    # "Permission denied" for the whole path, so the offending component has to
    # be identified here. This is the question the arm64 runner can answer and
    # this host cannot: every component on the local amd64 targets is 0755 and
    # traversable by the service user, yet arm64 fails with status=200/CHDIR.
    echo "--- WorkingDirectory path, component by component ---" >&2
    _xt_wd="${XT_CURRENT_LINK:-}"
    _xt_probe_dir="$(dirname "$_xt_wd")"
    for _xt_c in / "$(dirname "$_xt_probe_dir")" "$_xt_probe_dir" "$_xt_wd"; do
      printf '  %-46s mode=%-6s owner=%s:%s\n' "$_xt_c" \
        "$(stat -c %a "$_xt_c" 2>/dev/null || echo MISSING)" \
        "$(stat -c %U "$_xt_c" 2>/dev/null || echo -)" \
        "$(stat -c %G "$_xt_c" 2>/dev/null || echo -)" >&2
    done
    echo "  service user: ${SERVICE_USER}" >&2
    # `current` is a SYMLINK. stat follows links, but the walk above reported it
    # as mode=777 -- the mode of a symlink itself -- so the walk was describing
    # the link, not the release directory it points at. Resolve it and probe the
    # real directory, which is what systemd actually chdir()s into.
    echo "  current -> $(readlink -f "$XT_CURRENT_LINK" 2>/dev/null || echo UNRESOLVED)" >&2
    _xt_real="$(readlink -f "$XT_CURRENT_LINK" 2>/dev/null || true)"
    if [[ -n "$_xt_real" && -d "$_xt_real" ]]; then
      printf '    resolved target mode=%-6s owner=%s:%s\n' \
        "$(stat -c %a "$_xt_real")" "$(stat -c %U "$_xt_real")" "$(stat -c %G "$_xt_real")" >&2
      if su -s /bin/sh -c "cd '$_xt_real'" "$SERVICE_USER" >/dev/null 2>&1; then
        echo "    ok      resolved release dir" >&2
      else
        echo "    DENIED  resolved release dir   <- this is the cause" >&2
      fi
    else
      echo "    the symlink does not resolve to a directory" >&2
    fi
    echo "  can it traverse each component?" >&2
    for _xt_c in / "$(dirname "$_xt_probe_dir")" "$_xt_probe_dir" "$_xt_wd"; do
      if su -s /bin/sh -c "cd '$_xt_c'" "$SERVICE_USER" >/dev/null 2>&1; then
        printf '    ok      %s\n' "$_xt_c" >&2
      else
        printf '    DENIED  %s\n' "$_xt_c" >&2
      fi
    done
    echo "  (a DENIED line is the cause; a 200/CHDIR with all ok means the" >&2
    echo "   sandbox directives are blocking it, not the path modes)" >&2
    echo "--- xistance.service status ---" >&2
    systemctl status xistance.service --no-pager --lines 20 >&2 2>/dev/null || true
    echo "--- recent journal ---" >&2
    journalctl -u xistance.service --no-pager --lines 40 >&2 2>/dev/null || true
  fi
  echo "--- was the service even asked to start? ---" >&2
  echo "pid 1 is: $(ps -p 1 -o comm= 2>/dev/null || echo unknown)" >&2
  echo "systemctl: $(command -v systemctl || echo 'not present')" >&2
  echo "release dir: $CANDIDATE_DIR" >&2
  info "Readiness check failed; rolling back."
  xt_mark_release_failed "$CANDIDATE_DIR" 2>/dev/null || true
  if [[ -n "$PREVIOUS_ACTIVE" && -d "$PREVIOUS_ACTIVE" ]]; then
    xt_activate_release "$PREVIOUS_ACTIVE" 2>/dev/null || true
    if [[ "$FIXTURE_MODE" != "1" ]]; then
      systemctl restart xistance.service 2>/dev/null || true
    fi
    die "Install failed its readiness check. The previous release
(${PREVIOUS_ACTIVE}) has been restored and is active." 9
  fi
  die "Install failed its readiness check and there is no previous release to
restore. The failed release is at ${CANDIDATE_DIR}." 9
fi

ok "Xistance Panel ${VERSION} is installed and healthy on port ${PANEL_PORT}."
if [[ -n "$PREVIOUS_ACTIVE" ]]; then
  printf '   Previous release retained: %s\n' "$PREVIOUS_ACTIVE"
fi
printf '   Roll back with: xt-rollback %s\n' "$PREVIOUS_ACTIVE"
