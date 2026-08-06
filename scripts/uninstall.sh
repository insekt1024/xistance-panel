#!/usr/bin/env bash
#
# Xistance Panel — uninstall.sh
#
#   sudo bash scripts/uninstall.sh          # stop+remove service, keep data
#   sudo bash scripts/uninstall.sh --purge  # also remove data + binaries + backups
#
set -euo pipefail

C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YEL=$'\e[33m'; C_RST=$'\e[0m'
say() { printf '%s\n' "$1"; }
die() { printf '%s✗ %s%s\n' "$C_RED" "$1" "$C_RST" >&2; exit 1; }

INSTALL_DIR="/opt/xistance"
DATA_DIR="/var/lib/xistance"
ETC_DIR="/etc/xistance"
BACKUP_DIR="/var/backups/xistance"
PURGE=0

for a in "$@"; do
  case "$a" in
    --purge) PURGE=1;;
    --help|-h) echo "Usage: sudo bash scripts/uninstall.sh [--purge]"; exit 0;;
    *) die "Unknown option: $a";;
  esac
done

[[ "$(id -u)" -eq 0 ]] || die "Run as root (sudo bash scripts/uninstall.sh)"

say ""
say "  Xistance Panel — uninstall / حذف نصب"
say ""

if systemctl list-unit-files | grep -q '^xistance\.service'; then
  printf '%sStopping xistance.service…%s\n' "$C_YEL" "$C_RST"
  systemctl stop xistance.service 2>/dev/null || true
  systemctl disable xistance.service 2>/dev/null || true
  rm -f /etc/systemd/system/xistance.service
  systemctl daemon-reload
  systemctl reset-failed xistance.service 2>/dev/null || true
  printf '%s✓  Service removed.%s\n' "$C_GRN" "$C_RST"
fi

# Stop any panel-managed tunnel units
if command -v systemctl >/dev/null; then
  systemctl list-unit-files | grep -E '^xt-tunnel-.*\.service' \
    | awk '{print $1}' | while read -r u; do
      systemctl stop "$u" 2>/dev/null || true
      systemctl disable "$u" 2>/dev/null || true
      rm -f "/etc/systemd/system/$u"
    done
  systemctl daemon-reload 2>/dev/null || true
fi

rm -rf "$INSTALL_DIR"
printf '%s✓  Removed %s%s\n' "$C_GRN" "$INSTALL_DIR" "$C_RST"

if [[ $PURGE -eq 1 ]]; then
  rm -rf "$DATA_DIR" "$ETC_DIR" "$BACKUP_DIR"
  printf '%s✓  Purged data, config and backups.%s\n' "$C_GRN" "$C_RST"
else
  printf '%s   Data preserved in %s and %s (use --purge to delete).%s\n' \
    "$C_YEL" "$DATA_DIR" "$ETC_DIR" "$C_RST"
  printf '   پشتیبان‌ها در %s نگهداری می‌شوند (برای حذف کامل از --purge استفاده کنید).\n' "$BACKUP_DIR"
fi

say ""
printf '%s✓  Uninstall complete.%s\n' "$C_GRN" "$C_RST"
printf '   حذف نصب کامل شد.\n'
