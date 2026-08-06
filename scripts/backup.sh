#!/usr/bin/env bash
#
# Xistance Panel — backup.sh
#
# Creates a full backup of the database, config and binaries:
#
#   sudo bash scripts/backup.sh              # -> /var/backups/xistance/
#   sudo bash scripts/backup.sh /path/to/    # custom output dir
#
set -euo pipefail

C_GRN=$'\e[32m'; C_YEL=$'\e[33m'; C_RST=$'\e[0m'
C_RED=$'\e[31m'
say() { printf '%s\n' "$1"; }
die() { printf '%s✗ %s%s\n' "$C_RED" "$1" "$C_RST" >&2; exit 1; }

DATA_DIR="${XT_DATA_DIR:-/var/lib/xistance}"
ETC_DIR="/etc/xistance"
DEFAULT_OUT="/var/backups/xistance"
OUT_DIR="${1:-$DEFAULT_OUT}"
STAMP="$(date +%Y%m%d-%H%M%S)"
TARBALL="$OUT_DIR/xistance-backup-$STAMP.tar.gz"

[[ "$(id -u)" -eq 0 ]] || die "Run as root (sudo bash scripts/backup.sh)"
[[ -d "$DATA_DIR" || -d "$ETC_DIR" ]] || die "No installation found under $DATA_DIR / $ETC_DIR."

mkdir -p "$OUT_DIR"

# Snapshot the SQLite DB cleanly (WAL checkpoint)
if [[ -f "$DATA_DIR/xistance.db" ]]; then
  if command -v sqlite3 >/dev/null; then
    sqlite3 "$DATA_DIR/xistance.db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
  fi
fi

say "Creating backup → $TARBALL"
tar -czf "$TARBALL" \
  -C / \
  "${DATA_DIR#/}" "${ETC_DIR#/}" 2>/dev/null

if [[ -s "$TARBALL" ]]; then
  printf '%s✓  Backup saved: %s%s\n' "$C_GRN" "$TARBALL" "$C_RST"
  printf '   پشتیبان ذخیره شد: %s\n' "$TARBALL"
else
  rm -f "$TARBALL"
  die "Backup failed (empty archive)."
fi

# Restore:
#   sudo tar -xzf "$TARBALL" -C /
#   sudo systemctl restart xistance.service
say ""
say "Restore:  sudo tar -xzf \"$TARBALL\" -C / && sudo systemctl restart xistance.service"
say "بازیابی:  sudo tar -xzf \"$TARBALL\" -C / و سپس راه‌اندازی مجدد سرویس"
