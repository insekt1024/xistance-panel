#!/usr/bin/env bash
#
# Xistance Panel — update.sh
#
# Pulls the latest source, rebuilds the panel and restarts the service.
# Run from a repository checkout on the server:
#
#   sudo bash scripts/update.sh [master]
#
set -euo pipefail

C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YEL=$'\e[33m'; C_RST=$'\e[0m'
say() { printf '%s\n' "$1"; }
die() { printf '%s✗ %s%s\n' "$C_RED" "$1" "$C_RST" >&2; exit 1; }

INSTALL_DIR="/opt/xistance"
ENV_FILE="/etc/xistance/xistance.env"
BRANCH="${1:-master}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

[[ "$(id -u)" -eq 0 ]] || die "Run as root (sudo bash scripts/update.sh)"
[[ -d "$INSTALL_DIR" ]] || die "Panel is not installed (missing $INSTALL_DIR). Run scripts/install.sh first."

say ""
say "  Xistance Panel — update / به‌روزرسانی"
say ""

# 1. Back up current install + data
if command -v /bin/bash >/dev/null; then
  bash "$REPO_ROOT/scripts/backup.sh" || true
fi

# 2. Pull latest
if [[ -d "$REPO_ROOT/.git" ]]; then
  printf '%sPulling %s…%s\n' "$C_YEL" "$BRANCH" "$C_RST"
  git -C "$REPO_ROOT" fetch origin --prune
  git -C "$REPO_ROOT" checkout "$BRANCH" 2>/dev/null || true
  git -C "$REPO_ROOT" reset --hard "origin/$BRANCH"
else
  printf '%sNot a git checkout; skipping pull. Building current tree.%s\n' "$C_YEL" "$C_RST"
fi

# 3. Build
printf '%sInstalling dependencies…%s\n' "$C_YEL" "$C_RST"
( cd "$REPO_ROOT" && npm ci --no-audit --no-fund )
printf '%sBuilding panel…%s\n' "$C_YEL" "$C_RST"
( cd "$REPO_ROOT" && npm run build )

# 4. Copy build over the installed tree (preserve data dir)
printf '%sDeploying to %s…%s\n' "$C_YEL" "$INSTALL_DIR" "$C_RST"
if [[ -d "$REPO_ROOT/apps/web/.next/standalone" ]]; then
  cp -r "$REPO_ROOT/apps/web/.next/static" \
        "$REPO_ROOT/apps/web/.next/standalone/apps/web/.next/static" 2>/dev/null || true
fi
tar -C "$REPO_ROOT" --exclude=.git --exclude='*.db' --exclude=tunnels \
    --exclude=node_modules/.cache -cf - apps/web/.next packages/db/prisma packages/db/src \
    node_modules packages/db/generated 2>/dev/null \
  | tar -C "$INSTALL_DIR" -xf - || {
    # fallback: copy whole tree
    tar -C "$REPO_ROOT" --exclude=.git --exclude=.next --exclude='*.db' --exclude=tunnels -cf - . \
      | tar -C "$INSTALL_DIR" -xf -
    rm -rf "$INSTALL_DIR/apps/web/.next"
    cp -r "$REPO_ROOT/apps/web/.next" "$INSTALL_DIR/apps/web/.next"
  }

# 5. Forwarder runner
cp "$REPO_ROOT/packages/tunnel-core/src/forwarder-runner.ts" "/var/lib/xistance/forwarder-runner.ts" 2>/dev/null || true

# 6. Restart
if [[ -f "$ENV_FILE" ]]; then
  set -a; . "$ENV_FILE"; set +a
fi
systemctl daemon-reload 2>/dev/null || true
systemctl restart xistance.service 2>/dev/null || \
  say "   (xistance.service not present — start manually: systemctl start xistance.service)"

say ""
printf '%s✓  Update complete.%s\n' "$C_GRN" "$C_RST"
printf '   به‌روزرسانی کامل شد.\n'
