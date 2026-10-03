#!/usr/bin/env bash
#
# Xistance Panel — backup.sh
#
# Creates a full backup of the database, config and binaries:
#
#   sudo bash scripts/backup.sh                     # -> /var/backups/xistance/
#   sudo bash scripts/backup.sh /path/to/           # custom output dir
#   sudo bash scripts/backup.sh --verify FILE        # check an existing backup
#   sudo bash scripts/backup.sh --restore FILE --dest /
#
# A backup is only useful if it can be proven restorable, so creation verifies
# the result and refuses to keep an archive that does not pass. --verify and
# --restore do the same check again on an archive taken earlier.
#
set -euo pipefail

C_GRN=$'\e[32m'; C_YEL=$'\e[33m'; C_RST=$'\e[0m'
C_RED=$'\e[31m'
say() { printf '%s\n' "$1"; }
die() { printf '%s✗ %s%s\n' "$C_RED" "$1" "$C_RST" >&2; exit 1; }

# shellcheck source=lib/backup-lib.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/backup-lib.sh"

DATA_DIR="${XT_DATA_DIR:-/var/lib/xistance}"
ETC_DIR="${XT_ETC_DIR:-/etc/xistance}"
DEFAULT_OUT="/var/backups/xistance"
OUT_DIR="$DEFAULT_OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARBALL="$OUT_DIR/xistance-backup-$STAMP.tar.gz"

MODE="create"
RESTORE_DEST=""
ARG_ARCHIVE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --verify)
      MODE="verify"; ARG_ARCHIVE="${2:-}"; [[ -n "$ARG_ARCHIVE" ]] || die "--verify needs an archive path"; shift 2 ;;
    --verify=*)   MODE="verify"; ARG_ARCHIVE="${1#*=}"; shift ;;
    --restore)
      MODE="restore"; ARG_ARCHIVE="${2:-}"; [[ -n "$ARG_ARCHIVE" ]] || die "--restore needs an archive path"; shift 2 ;;
    --restore=*) MODE="restore"; ARG_ARCHIVE="${1#*=}"; shift ;;
    --dest)       RESTORE_DEST="${2:-}"; [[ -n "$RESTORE_DEST" ]] || die "--dest needs a directory"; shift 2 ;;
    --dest=*)     RESTORE_DEST="${1#*=}"; shift ;;
    -h|--help)    sed -n '3,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)           die "Unknown option: $1" 2 ;;
    *)            OUT_DIR="$1"; shift ;;
  esac
done

# Verify and restore must work on an archive an operator copied off the box,
# so they do not require root: they only read the archive and write the
# destination the caller named.
if [[ "$MODE" != "create" && "$(id -u)" -ne 0 && "${XT_ALLOW_NONROOT_RESTORE:-0}" != "1" ]]; then
  printf 'note: not running as root; the restored files will be owned by %s.\n' "$(id -un)"
fi

if [[ "$MODE" == "verify" ]]; then
  xt_backup_verify "$ARG_ARCHIVE"
  exit $?
fi

if [[ "$MODE" == "restore" ]]; then
  [[ -n "$RESTORE_DEST" ]] || die "--restore needs --dest <directory>"
  if xt_backup_restore "$ARG_ARCHIVE" "$RESTORE_DEST"; then
    say "$C_GRN✓  Restored into $RESTORE_DEST"
    say "   بازیابی شد."
    exit 0
  fi
  die "Restore failed. Nothing was changed."
fi

[[ "$(id -u)" -eq 0 ]] || die "Run as root (sudo bash scripts/backup.sh)"
[[ -d "$DATA_DIR" || -d "$ETC_DIR" ]] || die "No installation found under $DATA_DIR / $ETC_DIR."

mkdir -p "$OUT_DIR"

# backup.sh is the operator-facing tool, so it captures BOTH the data directory
# and the config directory. update.sh only ever backs up mutable data, because a
# release directory is reproducible from its artifact and is never part of a
# restore. Keeping the two explicit avoids a future caller silently backing up
# the wrong one.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/xt-full-backup.XXXXXX")" || die "Could not stage the backup."
trap 'rm -rf -- "$STAGE"' EXIT
mkdir -p "$STAGE/data" "$STAGE/etc"

for src in "$DATA_DIR" "$ETC_DIR"; do
  [[ -d "$src" ]] || continue
  name="$(basename "$src")"
  if ! cp -a "$src/." "$STAGE/$name/" 2>/dev/null; then
    die "Could not read $src"
  fi
done

# One archive holding both trees, plus a manifest and a checksum.
if ! xt_backup_create "$STAGE" "$TARBALL"; then
  die "Backup failed."
fi

if ! xt_backup_verify "$TARBALL"; then
  rm -f -- "$TARBALL" "${TARBALL}.sha256"
  die "The freshly created backup did not verify; nothing was kept."
fi

say "Contents:"
tar -tzf "$TARBALL" | grep -v "/$" | sed 's/^/   /' | head -40
say ""
say "$C_GRN✓  Backup saved: $TARBALL"
say "   SHA-256: $(xt_sha256 "$TARBALL")"
say "   پشتیبان ذخیره شد: $TARBALL"
say ""
say "Verify before trusting it:"
say "   bash scripts/backup.sh --verify \"$TARBALL\""
say ""
say "Restore:  sudo bash scripts/backup.sh --restore \"$TARBALL\" --dest /"
