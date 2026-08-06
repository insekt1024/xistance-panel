#!/usr/bin/env bash
#
# Xistance Panel — install.sh
#
# One-shot installer for Ubuntu/Debian (x86_64 / arm64).
#
#   sudo bash scripts/install.sh                     # panel + local node
#   sudo bash scripts/install.sh --port 8080
#   sudo bash scripts/install.sh --skip-firewall
#   sudo bash scripts/install.sh --rollback          # restore last backup
#   sudo bash scripts/install.sh --node iran         # prep a remote node (binaries only)
#   sudo bash scripts/install.sh --node foreign
#
# Environment overrides (all optional):
#   XT_ADMIN_EMAIL, XT_ADMIN_PASSWORD, XT_PORT, XT_DATA_DIR, XT_BIN_DIR,
#   XT_MIRROR (github-mirror base for binary downloads),
#   BACKHAUL_VERSION, FRP_VERSION, GOST_VERSION
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
INSTALL_DIR="${XT_INSTALL_DIR:-/opt/xistance}"
DATA_DIR="${XT_DATA_DIR:-/var/lib/xistance}"
BIN_DIR="${XT_BIN_DIR:-${DATA_DIR}/bin}"
ETC_DIR="/etc/xistance"
ENV_FILE="${ETC_DIR}/xistance.env"
PANEL_PORT="${XT_PORT:-8080}"
NODE_MIN="22.6.0"
BACKUP_DIR="/var/backups/xistance"
STAMP="$(date +%Y%m%d-%H%M%S)"

MODES="panel iran foreign"
MODE="panel"
SKIP_FIREWALL=0
ROLLBACK=0
NONINTERACTIVE=0

# Pinned versions (override with env). Fall back to GitHub "latest" when empty.
BACKHAUL_VERSION="${BACKHAUL_VERSION:-}"
FRP_VERSION="${FRP_VERSION:-}"
GOST_VERSION="${GOST_VERSION:-}"
MIRROR="${XT_MIRROR:-https://github.com}"

# ---------------------------------------------------------------------------
# Colours / output helpers (bilingual)
# ---------------------------------------------------------------------------
C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YEL=$'\e[33m'; C_BLU=$'\e[34m'; C_RST=$'\e[0m'

say()   { printf '%s\n' "$1"; }
note()  { printf '  %s\n' "$1"; }
info()  { printf '%s%s%s %s\n' "$C_BLU" "ℹ" "$C_RST" "$1"; printf '%s\n' "   $2"; }
ok()    { printf '%s✓ %s%s\n' "$C_GRN" "$1" "$C_RST"; printf '   %s\n' "$2"; }
warn()  { printf '%s⚠ %s%s\n' "$C_YEL" "$1" "$C_RST"; printf '   %s\n' "$2"; }
die()   { printf '%s✗ %s%s\n' "$C_RED" "$1" "$C_RST" >&2; printf '   %s\n' "$2" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
usage() {
  cat <<'EOF'
Xistance Panel installer
Usage: sudo bash scripts/install.sh [options]

  --node <iran|foreign>   Install only the tunnel binaries for a remote node
  --port <PORT>           Panel HTTP port (default: 8080)
  --skip-firewall         Do not open firewall ports
  --rollback              Restore the previous installation backup
  --yes                   Non-interactive (accept defaults)
  --help                  Show this help
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node) MODE="${2:-}"; shift 2;;
    --port) PANEL_PORT="${2:-}"; shift 2;;
    --skip-firewall) SKIP_FIREWALL=1; shift;;
    --rollback) ROLLBACK=1; shift;;
    --yes) NONINTERACTIVE=1; shift;;
    --help|-h) usage;;
    *) die "Unknown option: $1" "گزینه ناشناخته: $1";;
  esac
done

if [[ "$MODE" != "panel" ]] && ! grep -q "^$MODE$" <<<"$MODES"; then
  die "Invalid --node mode: $MODE (expected iran or foreign)" \
      "حالت گره نامعتبر است: $MODE (ایران یا خارج)"
fi

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
need_root() {
  [[ "$(id -u)" -eq 0 ]] || die "Run as root (sudo bash scripts/install.sh)" \
                              "این اسکریپت باید با دسترسی ریشه (root) اجرا شود."
}

need_cmd() { command -v "$1" >/dev/null 2>&1; }

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)  echo "amd64";;
    aarch64|arm64) echo "arm64";;
    *) die "Unsupported architecture: $(uname -m)" "معماری پشتیبانی‌نشده: $(uname -m)";;
  esac
}

detect_os() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    case "$ID" in
      ubuntu|debian) return 0;;
    esac
  fi
  die "This installer supports Ubuntu/Debian only." \
      "این نصب‌کننده فقط اوبونتو/دبیان را پشتیبانی می‌کند."
}

# ---------------------------------------------------------------------------
# Backup / rollback
# ---------------------------------------------------------------------------
backup_existing() {
  if [[ ! -d "$INSTALL_DIR" && ! -d "$DATA_DIR" && ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  mkdir -p "$BACKUP_DIR"
  local dst="$BACKUP_DIR/xistance-$STAMP.tar.gz"
  info "Backing up previous installation…" "در حال پشتیبان‌گیری از نصب قبلی…"
  tar -czf "$dst" -C / \
    "${INSTALL_DIR#/}" "${DATA_DIR#/}" "${ETC_DIR#/}" 2>/dev/null || true
  [[ -s "$dst" ]] && ok "Backup saved: $dst" "پشتیبان ذخیره شد: $dst"
  # keep last 5
  ls -1t "$BACKUP_DIR"/xistance-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f
}

do_rollback() {
  local newest
  newest="$(ls -1t "$BACKUP_DIR"/xistance-*.tar.gz 2>/dev/null | head -1)"
  [[ -n "$newest" ]] || die "No backup found to roll back to." "هیچ پشتیبان‌ی برای بازگشت یافت نشد."
  info "Restoring backup: $newest" "در حال بازیابی پشتیبان: $newest"
  systemctl stop xistance.service 2>/dev/null || true
  tar -xzf "$newest" -C /
  systemctl daemon-reload 2>/dev/null || true
  systemctl start xistance.service 2>/dev/null || true
  ok "Rollback complete." "بازگشت کامل شد."
  exit 0
}

# ---------------------------------------------------------------------------
# System dependencies
# ---------------------------------------------------------------------------
install_deps() {
  info "Installing system packages…" "در حال نصب بسته‌های سیستمی…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
    ca-certificates curl unzip jq sqlite3 openssh-client sshpass tar gnupg \
    systemd ufw >/dev/null
  ok "System packages installed." "بسته‌های سیستمی نصب شدند."
}

# ---------------------------------------------------------------------------
# Node.js (LTS >= 22.6 for --experimental-strip-types)
# ---------------------------------------------------------------------------
ensure_node() {
  if need_cmd node; then
    local v major
    v="$(node -v | tr -d 'v')"
    major="${v%%.*}"
    if (( major >= 22 )); then
      ok "Node.js $(node -v) detected." "Node.js $(node -v) یافت شد."
      return 0
    fi
    warn "Node.js $v is too old (>= 22.6 required). Installing LTS…" \
         "نسخه Node.js $v قدیمی است (نسخه ۲۲.۶ یا بالاتر نیاز است). در حال نصب…"
  fi
  export DEBIAN_FRONTEND=noninteractive
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y nodejs >/dev/null
  node -v | grep -q '^v2[2-9]' || die "Node.js install failed." "نصب Node.js ناموفق بود."
  ok "Node.js $(node -v) installed." "Node.js $(node -v) نصب شد."
}

# ---------------------------------------------------------------------------
# Tunnel binaries (backhaul / frpc+frps / gost)
# ---------------------------------------------------------------------------
ARCH="$(detect_arch)"
GO_ARCH=$([[ "$ARCH" == "amd64" ]] && echo "amd64" || echo "arm64")

latest_release() { # repo  -> version tag (tag_name), "v0.0.0" when unknown
  local tag
  tag="$(curl -fsSL --connect-timeout 10 "https://api.github.com/repos/$1/releases/latest" 2>/dev/null \
        | jq -r '.tag_name' 2>/dev/null)"
  printf '%s' "${tag:-unknown}"
}

fetch_and_extract() { # url asset-name dst-dir bin-names...
  local url="$1" asset="$2" dst="$3"; shift 3
  local tmp; tmp="$(mktemp -d)"
  curl -fL --retry 3 --connect-timeout 15 -o "$tmp/$asset" "$url"
  case "$asset" in
    *.tar.gz|*.tgz) tar -xzf "$tmp/$asset" -C "$tmp";;
    *.zip)          unzip -q -o "$tmp/$asset" -d "$tmp";;
  esac
  mkdir -p "$dst"
  local n found=0
  for n in "$@"; do
    if find "$tmp" -type f -name "$n" -exec cp {} "$dst/" \; >/dev/null 2>&1; then
      chmod +x "$dst/$n"; found=1
    fi
  done
  rm -rf "$tmp"
  [[ $found -eq 1 ]] || return 1
}

install_binaries() {
  mkdir -p "$BIN_DIR"
  local bh_ver fp_ver gost_ver

  bh_ver="${BACKHAUL_VERSION:-$(latest_release Musixal/Backhaul)}"
  [[ "$bh_ver" == "unknown" ]] && bh_ver="v0.7.2"
  info "Installing backhaul $bh_ver…" "در حال نصب backhaul…"
  if fetch_and_extract \
      "$MIRROR/Musixal/Backhaul/releases/download/$bh_ver/backhaul_linux_${GO_ARCH}.tar.gz" \
      "backhaul_linux_${GO_ARCH}.tar.gz" "$BIN_DIR" backhaul; then
    ok "backhaul installed." "backhaul نصب شد."
  else
    warn "backhaul download failed; try BACKHAUL_VERSION=<tag> or XT_MIRROR." \
         "دانلود backhaul ناموفق بود."
  fi

  fp_ver="${FRP_VERSION:-$(latest_release fatedier/frp)}"
  [[ "$fp_ver" == "unknown" ]] && fp_ver="v0.70.1"
  info "Installing frp $fp_ver (frpc + frps)…" "در حال نصب frp…"
  local fp_asset="frp_${fp_ver#v}_linux_${GO_ARCH}.tar.gz"
  if fetch_and_extract \
      "$MIRROR/fatedier/frp/releases/download/$fp_ver/$fp_asset" \
      "$fp_asset" "$BIN_DIR" frpc frps; then
    ok "frpc + frps installed." "frpc و frps نصب شدند."
  else
    warn "frp download failed; check FRP_VERSION=<tag>." "دانلود frp ناموفق بود."
  fi

  gost_ver="${GOST_VERSION:-$(latest_release ginuerzh/gost)}"
  [[ "$gost_ver" == "unknown" ]] && gost_ver="v2.12.0"
  info "Installing gost $gost_ver…" "در حال نصب gost…"
  local g_asset="gost_${gost_ver#v}_linux_${GO_ARCH}.tar.gz"
  if fetch_and_extract \
      "$MIRROR/ginuerzh/gost/releases/download/$gost_ver/$g_asset" \
      "$g_asset" "$BIN_DIR" gost; then
    ok "gost installed." "gost نصب شد."
  else
    warn "gost download failed; check GOST_VERSION=<tag>." "دانلود gost ناموفق بود."
  fi

  ls -1 "$BIN_DIR" | sed 's/^/    /'
  [[ -n "$(ls -A "$BIN_DIR" 2>/dev/null)" ]] || \
    die "No binaries were installed. Provide network access or XT_MIRROR." \
        "هیچ باینری نصب نشد. دسترسی شبکه یا XT_MIRROR را فراهم کنید."
}

# ---------------------------------------------------------------------------
# Secrets + env file
# ---------------------------------------------------------------------------
gen_hex()  { openssl rand -hex 32; }
gen_pass() { openssl rand -base64 18 | tr -d '/+=' | head -c 20; }

write_env() {
  mkdir -p "$ETC_DIR"
  local enc jwt
  [[ -s "$ENV_FILE" ]] || {
    enc="$(gen_hex)"
    jwt="$(gen_hex)"
    cat > "$ENV_FILE" <<EOF
# Xistance Panel — environment (chmod 600). Managed by install.sh.
DATABASE_URL=file:${DATA_DIR}/xistance.db
XT_DATA_DIR=${DATA_DIR}
XT_BIN_DIR=${BIN_DIR}
XT_ENV_FILE=${ENV_FILE}
XT_FORWARDER_SCRIPT=${DATA_DIR}/forwarder-runner.ts
XTENC_KEY=${enc}
JWT_SECRET=${jwt}
PORT=${PANEL_PORT}
HOSTNAME=0.0.0.0
NODE_ENV=production
EOF
    chmod 600 "$ENV_FILE"
  }
  ok "Environment written: $ENV_FILE" "فایل محیط‌نوشته شد: $ENV_FILE"
}

# ---------------------------------------------------------------------------
# Panel build + deploy
# ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

build_panel() {
  [[ -f "$REPO_ROOT/package.json" ]] || die "Not a repo checkout. Clone xistance-panel first." \
                                            "این پوشه مخزن نیست؛ ابتدا xistance-panel را clone کنید."
  info "Installing dependencies…" "در حال نصب وابستگی‌ها…"
  ( cd "$REPO_ROOT" && npm ci --no-audit --no-fund >/dev/null 2>&1 )
  info "Building panel (this may take a few minutes)…" "در حال ساخت پنل (چند دقیقه طول می‌کشد)…"
  ( cd "$REPO_ROOT" && npm run build >/dev/null 2>&1 )
  # next standalone server needs static assets alongside it
  if [[ -d "$REPO_ROOT/apps/web/.next/standalone" ]]; then
    cp -r "$REPO_ROOT/apps/web/.next/static" \
          "$REPO_ROOT/apps/web/.next/standalone/apps/web/.next/static" 2>/dev/null || true
  fi
  ok "Panel build complete." "ساخت پنل کامل شد."
}

deploy_panel() {
  backup_existing
  mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$ETC_DIR"
  info "Deploying to $INSTALL_DIR…" "در حال استقرار در $INSTALL_DIR…"
  # Copy the checkout (source + built output + node_modules) excluding caches.
  tar -C "$REPO_ROOT" --exclude=.git --exclude=.next --exclude=tunnels \
      --exclude='*.db' -cf - . \
    | tar -C "$INSTALL_DIR" -xf -
  # Replace .next with the standalone-capable build
  rm -rf "$INSTALL_DIR/apps/web/.next"
  cp -r "$REPO_ROOT/apps/web/.next" "$INSTALL_DIR/apps/web/.next"
  # forwarder-runner (self-contained)
  cp "$REPO_ROOT/packages/tunnel-core/src/forwarder-runner.ts" "$DATA_DIR/forwarder-runner.ts"
  ok "Deployed to $INSTALL_DIR." "استقرار در $INSTALL_DIR کامل شد."
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
init_db() {
  local admin_email="${XT_ADMIN_EMAIL:-admin@xistance.local}"
  local admin_pass="${XT_ADMIN_PASSWORD:-$(gen_pass)}"
  info "Initialising database…" "در حال مقداردهی پایگاه‌داده…"
  local dbdir="$INSTALL_DIR/packages/db"
  (
    cd "$dbdir" || exit 1
    set -a; . "$ENV_FILE"; set +a
    npx prisma db push --accept-data-loss --skip-generate >/dev/null 2>&1 \
      || { npx prisma generate >/dev/null 2>&1 \
           && npx prisma db push --accept-data-loss >/dev/null 2>&1; }
    XT_ADMIN_EMAIL="$admin_email" XT_ADMIN_PASSWORD="$admin_pass" \
      npx prisma db seed >/dev/null 2>&1
  )
  ok "Database ready. Admin: $admin_email" \
     "پایگاه‌داده آماده است. مدیر: $admin_email"
  if [[ "${XT_ADMIN_PASSWORD:-}" == "" ]]; then
    say ""
    printf '%s%s%s\n' "$C_YEL" "  Initial admin password: $admin_pass" "$C_RST"
    printf '%s\n' "  رمز عبور اولیه مدیر: $admin_pass"
    say ""
  fi
}

# ---------------------------------------------------------------------------
# systemd
# ---------------------------------------------------------------------------
install_systemd() {
  local server_js="$INSTALL_DIR/apps/web/.next/standalone/apps/web/server.js"
  [[ -f "$server_js" ]] || server_js="$INSTALL_DIR/apps/web/server.js"
  cat > /etc/systemd/system/xistance.service <<EOF
[Unit]
Description=Xistance Tunnel Control Panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${ENV_FILE}
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/env node ${server_js}
Restart=on-failure
RestartSec=5
User=root
RuntimeDirectory=xistance
RuntimeDirectoryMode=0750

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable xistance.service >/dev/null 2>&1
  systemctl restart xistance.service
  ok "Panel service installed + started (xistance.service)." \
     "سرویس پنل نصب و راه‌اندازی شد (xistance.service)."
}

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------
firewall_wizard() {
  [[ $SKIP_FIREWALL -eq 1 ]] && { warn "Firewall skipped." "فایروال نادیده گرفته شد."; return; }
  if [[ "$MODE" == "panel" ]] && need_cmd ufw && systemctl is-active ufw >/dev/null 2>&1; then
    ufw allow "$PANEL_PORT"/tcp >/dev/null 2>&1 || true
    if [[ $NONINTERACTIVE -eq 0 ]]; then
      say ""
      read -r -p "Open extra TCP range for tunnels (e.g. 30000-40000)? [N/y] " ans
      if [[ "${ans,,}" == "y" ]]; then
        read -r -p "Port range: " range
        ufw allow "$range"/tcp >/dev/null 2>&1 || true
      fi
    fi
    ok "Firewall: opened port $PANEL_PORT." "فایروال: پورت $PANEL_PORT باز شد."
  fi
}

# ---------------------------------------------------------------------------
# Node mode (remote VPS bootstrap)
# ---------------------------------------------------------------------------
install_node_mode() {
  install_deps
  ensure_node
  install_binaries
  if [[ $SKIP_FIREWALL -eq 0 ]] && need_cmd ufw; then
    if [[ $NONINTERACTIVE -eq 0 ]]; then
      read -r -p "Open wide TCP/UDP range for tunnel traffic (e.g. 30000-65535)? [N/y] " ans
      [[ "${ans,,}" == "y" ]] && { read -r -p "Range: " r; ufw allow "$r" >/dev/null 2>&1 || true; }
    fi
  fi
  say ""
  ok "Node '$MODE' prepared. Binaries in $BIN_DIR." \
     "گره «$MODE» آماده شد. باینری‌ها در $BIN_DIR قرار دارند."
  note "Register this server in the panel's Nodes page using its host/IP, SSH port and key."
  note "برای مدیریت از طریق پنل، این سرور را در صفحه گره‌ها ثبت کنید."
  exit 0
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  need_root
  if [[ $ROLLBACK -eq 1 ]]; then do_rollback; fi
  detect_os
  install_deps
  ensure_node

  case "$MODE" in
    panel)
      say ""
      say "  ┌─────────────────────────────────────────────┐"
      say "  │   Xistance Panel — install / نصب پنل         │"
      say "  └─────────────────────────────────────────────┘"
      install_binaries
      write_env
      build_panel
      deploy_panel
      init_db
      install_systemd
      firewall_wizard
      say ""
      ok "Installation complete." "نصب با موفقیت کامل شد."
      say "  Panel:  http://<server-ip>:${PANEL_PORT}"
      say "  پنل:    http://<ip-سرور>:${PANEL_PORT}"
      say "  Docs:   README.md  ·  Backup: bash scripts/backup.sh"
      say "  پشتیبان‌گیری: bash scripts/backup.sh"
      say ""
      ;;
    iran|foreign) install_node_mode;;
  esac
}

main "$@"
