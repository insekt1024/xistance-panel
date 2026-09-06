#!/usr/bin/env bash
#
# Xistance Panel — install.sh
#
# Robust, resumable installer for Ubuntu 22.04 / 24.04 (and Debian), x86_64 / arm64.
#
# Quick one-liner (downloads bootstrap, then runs this script):
#   curl -fsSL https://raw.githubusercontent.com/insekt1024/xistance-panel/master/scripts/bootstrap.sh \
#     -o /tmp/xp-install.sh && sudo bash /tmp/xp-install.sh --port 8080 \
#     --admin-email you@example.com
#
# From a local checkout:
#   sudo bash scripts/install.sh                                  # panel + local node
#   sudo bash scripts/install.sh --port 8080 --admin-email a@b.c --admin-password S3cret!
#   sudo bash scripts/install.sh --menu                           # process-control menu
#   sudo bash scripts/install.sh --resume                         # continue after a failure (default)
#   sudo bash scripts/install.sh --from build                     # restart from a step
#   sudo bash scripts/install.sh --only binaries                  # run a single step
#   sudo bash scripts/install.sh --node iran                      # remote-node binaries only
#   sudo bash scripts/install.sh --rollback                       # restore last backup
#   sudo bash scripts/install.sh --status                         # service + health status
#
# Steps (recorded in $DATA_DIR/.install-state, skipped when already done):
#   preflight → deps → node → swap → binaries → env → build → deploy → db → systemd → firewall → verify
#
# Environment overrides (all optional, CLI flags win):
#   XT_ADMIN_EMAIL, XT_ADMIN_PASSWORD, XT_PORT, XT_DATA_DIR, XT_BIN_DIR,
#   XT_INSTALL_DIR, XT_MIRROR (github-mirror base for binary downloads),
#   BACKHAUL_VERSION, FRP_VERSION, GOST_VERSION, XT_LANG (en|fa)
#
set -uo pipefail

# ---------------------------------------------------------------------------
# Defaults (may be overridden by CLI flags below)
# ---------------------------------------------------------------------------
INSTALL_DIR="${XT_INSTALL_DIR:-/opt/xistance}"
DATA_DIR="${XT_DATA_DIR:-/var/lib/xistance}"
BIN_DIR="${XT_BIN_DIR:-${DATA_DIR}/bin}"
BIN_DIR_CUSTOM=0
[[ -n "${XT_BIN_DIR:-}" ]] && BIN_DIR_CUSTOM=1
ETC_DIR="/etc/xistance"
ENV_FILE="${ETC_DIR}/xistance.env"
PANEL_PORT="${XT_PORT:-8080}"
ADMIN_EMAIL="${XT_ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${XT_ADMIN_PASSWORD:-}"
LANG_PREF="${XT_LANG:-en}"
NODE_MIN_MAJOR=22
BACKUP_DIR="/var/backups/xistance"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="/var/log/xistance-install.log"

MODES="panel iran foreign"
MODE="panel"
SKIP_FIREWALL=0
ROLLBACK=0
NONINTERACTIVE=0
ALLOW_OS=0
NO_SWAP=0
REDO=0
NO_RESUME=0
FROM_STEP=""
ONLY_STEP=""
SHOW_MENU=0
SHOW_STATUS=0
SHOW_VERSION=0
REPO_URL="https://github.com/insekt1024/xistance-panel.git"
BRANCH="master"

BACKHAUL_VERSION="${BACKHAUL_VERSION:-}"
FRP_VERSION="${FRP_VERSION:-}"
GOST_VERSION="${GOST_VERSION:-}"
MIRROR="${XT_MIRROR:-https://github.com}"

STEPS=(preflight deps node swap binaries env build deploy db systemd firewall verify)

# ---------------------------------------------------------------------------
# Colours / output helpers (bilingual: English + فارسی)
# ---------------------------------------------------------------------------
C_RED=$'\e[31m'; C_GRN=$'\e[32m'; C_YEL=$'\e[33m'; C_BLU=$'\e[34m'; C_CYN=$'\e[36m'; C_RST=$'\e[0m'

say()   { printf '%s\n' "$1"; }
note()  { printf '  %s\n' "$1"; }
info()  { printf '%s%s%s %s\n' "$C_BLU" "ℹ" "$C_RST" "$1"; printf '%s\n' "   $2"; log "INFO: $1"; }
ok()    { printf '%s✓ %s%s\n' "$C_GRN" "$1" "$C_RST"; printf '   %s\n' "$2"; log "OK: $1"; }
warn()  { printf '%s⚠ %s%s\n' "$C_YEL" "$1" "$C_RST"; printf '   %s\n' "$2"; log "WARN: $1"; }
die()   { printf '%s✗ %s%s\n' "$C_RED" "$1" "$C_RST" >&2; printf '   %s\n' "$2" >&2; log "FATAL: $1"; exit 1; }
log()   { [[ -n "${LOG_FILE:-}" ]] && printf '[%s] %s\n' "$(date '+%F %T')" "$1" >>"$LOG_FILE" 2>/dev/null || true; }

banner() {
  local ver="unknown"
  [[ -f "$REPO_ROOT/package.json" ]] && \
    ver="$(grep -m1 '"version"' "$REPO_ROOT/package.json" | sed 's/[^0-9.]//g')"
  say ""
  printf '%s%s%s\n' "$C_CYN" '  __  __ ___ ____ _____  _    _   _  ____ _____ ' "$C_RST"
  printf '%s%s%s\n' "$C_CYN" '  \ \/ // __|_   _|_ _|/ \  | \ | |/ ___| ____|' "$C_RST"
  printf '%s%s%s\n' "$C_CYN" '   \  / \__ \ | |  | |/ _ \ |  \| | |   |  _|  ' "$C_RST"
  printf '%s%s%s\n' "$C_CYN" '   /  \ ___) || |  | / ___ \| |\  | |___| |___ ' "$C_RST"
  printf '%s%s%s\n' "$C_CYN" '  /_/\_\____/ |_| |_/_/   \_\_| \_|\____|_____| ' "$C_RST"
  say "   Xistance Panel installer  ·  v${ver}  ·  نصب پنل ایکسیستنس"
  say ""
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
usage() {
  cat <<'EOF'
Xistance Panel installer
Usage: sudo bash scripts/install.sh [options]

  --port <PORT>          Panel HTTP port (default: 8080, or $XT_PORT)
  --admin-email <EMAIL>  Admin login email (default: admin@xistance.local)
  --admin-password <PW>  Admin password (generated + printed if omitted)
  --data-dir <DIR>       Data dir (default: /var/lib/xistance)
  --install-dir <DIR>    Install dir (default: /opt/xistance)
  --branch <NAME>        Checkout branch for menu-driven update (default: master)
  --repo <URL>           Upstream repo (default: github.com/insekt1024/xistance-panel)
  --lang <en|fa>         Message language for prompts (default: en)
  --node <iran|foreign>  Install only tunnel binaries for a remote node
  --skip-firewall        Do not open firewall ports
  --no-swap              Do not auto-provision a swapfile on low-RAM hosts
  --resume               Resume: skip steps already done (default behaviour)
  --no-resume            Re-run every step from scratch
  --redo                 Force re-run of completed steps
  --from <STEP>          Start from STEP (preflight|deps|node|swap|binaries|env|build|deploy|db|systemd|firewall|verify)
  --only <STEP>          Run only STEP and exit
  --menu                 Interactive process-control menu
  --status               Show service + health status and exit
  --rollback             Restore the previous installation backup
  --allow-os             Allow untested OS versions (Ubuntu 22.04/24.04 are supported)
  --yes                  Non-interactive (accept defaults, never prompt)
  --version              Print installer version and exit
  --help                 Show this help
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PANEL_PORT="${2:-}"; shift 2;;
    --port=*) PANEL_PORT="${1#*=}"; shift;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift 2;;
    --admin-email=*) ADMIN_EMAIL="${1#*=}"; shift;;
    --admin-password) ADMIN_PASSWORD="${2:-}"; shift 2;;
    --admin-password=*) ADMIN_PASSWORD="${1#*=}"; shift;;
    --data-dir) DATA_DIR="${2:-}"; [[ "$BIN_DIR_CUSTOM" -eq 0 ]] && BIN_DIR="${DATA_DIR}/bin"; shift 2;;
    --data-dir=*) DATA_DIR="${1#*=}"; [[ "$BIN_DIR_CUSTOM" -eq 0 ]] && BIN_DIR="${DATA_DIR}/bin"; shift;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2;;
    --install-dir=*) INSTALL_DIR="${1#*=}"; shift;;
    --branch) BRANCH="${2:-}"; shift 2;;
    --branch=*) BRANCH="${1#*=}"; shift;;
    --repo) REPO_URL="${2:-}"; shift 2;;
    --repo=*) REPO_URL="${1#*=}"; shift;;
    --lang) LANG_PREF="${2:-en}"; shift 2;;
    --lang=*) LANG_PREF="${1#*=}"; shift;;
    --node) MODE="${2:-}"; shift 2;;
    --skip-firewall) SKIP_FIREWALL=1; shift;;
    --no-swap) NO_SWAP=1; shift;;
    --resume) NO_RESUME=0; shift;;
    --no-resume) NO_RESUME=1; shift;;
    --redo) REDO=1; shift;;
    --from) FROM_STEP="${2:-}"; shift 2;;
    --from=*) FROM_STEP="${1#*=}"; shift;;
    --only) ONLY_STEP="${2:-}"; shift 2;;
    --only=*) ONLY_STEP="${1#*=}"; shift;;
    --menu) SHOW_MENU=1; shift;;
    --status) SHOW_STATUS=1; shift;;
    --rollback) ROLLBACK=1; shift;;
    --allow-os) ALLOW_OS=1; shift;;
    --yes) NONINTERACTIVE=1; shift;;
    --version) SHOW_VERSION=1; shift;;
    --help|-h) usage;;
    *) die "Unknown option: $1" "گزینه ناشناخته: $1";;
  esac
done

# BIN_DIR already follows DATA_DIR unless XT_BIN_DIR was set explicitly.
STATE_FILE="${DATA_DIR}/.install-state"

if [[ "$MODE" != "panel" ]] && ! grep -q "^$MODE$" <<<"$MODES"; then
  die "Invalid --node mode: $MODE (expected iran or foreign)" \
      "حالت گره نامعتبر است: $MODE (ایران یا خارج)"
fi
for s in $FROM_STEP $ONLY_STEP; do
  [[ -z "$s" ]] && continue
  [[ " ${STEPS[*]} " == *" $s "* ]] || die "Unknown step: $s (see --help)" "گام نامعتبر: $s"
done
[[ "$PANEL_PORT" =~ ^[0-9]+$ ]] && (( PANEL_PORT >= 1 && PANEL_PORT <= 65535 )) \
  || die "Invalid --port: $PANEL_PORT (1-65535)" "پورت نامعتبر: $PANEL_PORT"
if [[ -n "$ADMIN_EMAIL" ]] && [[ ! "$ADMIN_EMAIL" =~ ^[^@]+@[^@]+\.[^@]+$ ]]; then
  die "Invalid --admin-email: $ADMIN_EMAIL" "ایمیل مدیر نامعتبر است: $ADMIN_EMAIL"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "$SHOW_VERSION" -eq 1 ]]; then
  grep -m1 '"version"' "$REPO_ROOT/package.json" 2>/dev/null | sed 's/[^0-9.]//g' || echo "unknown"
  exit 0
fi

# Log to file from here on (--help/--version stay clean above).
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || LOG_FILE=""
log "=== install.sh started: mode=$MODE port=$PANEL_PORT from=$FROM_STEP only=$ONLY_STEP ==="

# ---------------------------------------------------------------------------
# Resume state
# ---------------------------------------------------------------------------
step_done() { [[ -f "$STATE_FILE" ]] && grep -qx "$1" "$STATE_FILE" 2>/dev/null; }
mark_done() { mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true; grep -qx "$1" "$STATE_FILE" 2>/dev/null || echo "$1" >>"$STATE_FILE"; }
step_index() { local i s; for i in "${!STEPS[@]}"; do [[ "${STEPS[$i]}" == "$1" ]] && { echo "$i"; return; }; done; echo -1; }

should_run() { # <step> -> 0 = run, 1 = skip
  local s="$1"
  if [[ -n "$ONLY_STEP" ]]; then [[ "$s" == "$ONLY_STEP" ]] && return 0 || return 1; fi
  if [[ -n "$FROM_STEP" ]]; then
    (( $(step_index "$s") >= $(step_index "$FROM_STEP") )) || return 1
  fi
  if [[ "$REDO" -eq 0 && "$NO_RESUME" -eq 0 ]] && step_done "$s"; then
    note "Skipping '$s' (already done — use --redo to force)."
    log "SKIP (done): $s"
    return 1
  fi
  return 0
}

# Run a step with failure fallback: retry / skip / abort.
run_step() { # <step> <func> [args...]
  local s="$1"; shift
  should_run "$s" || return 0
  info "Step: $s…" "گام: $s…"
  if "$@"; then
    mark_done "$s"
    return 0
  fi
  local rc=$?
  warn "Step '$s' failed (exit $rc)." "گام «$s» ناموفق بود."
  log "FAIL: $s (exit $rc)"
  if [[ "$NONINTERACTIVE" -eq 1 ]]; then
    die "Aborting. Re-run the same command to resume (completed steps are skipped)." \
        "متوقف شد. برای ادامه از همان دستور استفاده کنید."
  fi
  say "  [r]etry / [s]kip (continue with warning) / [a]bort"
  local ans
  read -r -p "  Choice [r/s/a]: " ans
  case "${ans,,}" in
    s*) warn "Continuing without '$s'." "بدون «$s» ادامه می‌دهیم."; return 0;;
    a*) die "Aborted by user. Re-run to resume." "توسط کاربر متوقف شد.";;
    *)  log "RETRY: $s"; run_step "$s" "$@";;
  esac
}

prompt_default() { # <var> <prompt> <default>
  local var="$1" prompt="$2" def="$3" val
  if [[ "$NONINTERACTIVE" -eq 1 ]]; then printf -v "$var" '%s' "$def"; return; fi
  read -r -p "  $prompt [$def]: " val
  printf -v "$var" '%s' "${val:-$def}"
}

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

preflight() {
  need_root
  local arch; arch="$(detect_arch)"
  local os_id="unknown" os_ver="unknown"
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    os_id="${ID:-unknown}"; os_ver="${VERSION_ID:-unknown}"
  fi
  info "Target: $os_id $os_ver · $arch · port $PANEL_PORT" "هدف: $os_id $os_ver"
  case "$os_id" in
    ubuntu|debian) ;;
    *) [[ "$ALLOW_OS" -eq 1 ]] && warn "Untested OS ($os_id); continuing with --allow-os." "سیستم‌عامل تست‌نشده." \
       || die "Supports Ubuntu/Debian only (use --allow-os to override)." "فقط اوبونتو/دبیان.";;
  esac
  if [[ "$os_id" == "ubuntu" && "$os_ver" != "22.04" && "$os_ver" != "24.04" ]]; then
    warn "Ubuntu $os_ver is not in the tested matrix (22.04, 24.04)." "اوبونتو $os_ver در ماتریس تست نیست."
  fi
  # Disk space (>= 2G free where we install).
  local parent="$INSTALL_DIR"; [[ -d "$parent" ]] || parent="$(dirname "$parent")"
  local free_kb; free_kb="$(df -k "$parent" 2>/dev/null | awk 'NR==2{print $4}')"
  [[ -n "$free_kb" ]] && (( free_kb < 2097152 )) && \
    die "Need >= 2G free disk (have $((free_kb/1024))M)." "فضای دیسک کافی نیست."
  # RAM warning.
  local mem_kb; mem_kb="$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  (( mem_kb > 0 && mem_kb < 900000 )) && warn "Low RAM ($((mem_kb/1024))M); build may be slow." "رم کم است."
  # Port must be free.
  if (command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":${PANEL_PORT} ") || \
     (exec 3<>"/dev/tcp/127.0.0.1/${PANEL_PORT}" 2>/dev/null); then
    exec 3>&- 2>/dev/null || true
    die "Port $PANEL_PORT is already in use. Pick another with --port." "پورت $PANEL_PORT اشغال است."
  fi
  # systemd + connectivity are warnings (mirror/offline setups exist).
  [[ "$(ps -p 1 -o comm= 2>/dev/null)" == *systemd* ]] || \
    warn "PID 1 is not systemd; service install may fail." "systemd یافت نشد."
  curl -fsSI --max-time 10 https://github.com >/dev/null 2>&1 || \
    warn "github.com unreachable; set XT_MIRROR if downloads fail." "اتصال به github برقرار نیست."
  ok "Preflight checks passed." "بررسی‌های اولیه موفق بود."
}

collect_inputs() {
  [[ "$NONINTERACTIVE" -eq 1 ]] && return 0
  say ""
  say "  Configure installation (Enter = default):"
  prompt_default PANEL_PORT "Panel port" "$PANEL_PORT"
  [[ "$PANEL_PORT" =~ ^[0-9]+$ ]] && (( PANEL_PORT >= 1 && PANEL_PORT <= 65535 )) \
    || die "Invalid port: $PANEL_PORT" "پورت نامعتبر."
  prompt_default ADMIN_EMAIL "Admin email" "${ADMIN_EMAIL:-admin@xistance.local}"
  [[ "$ADMIN_EMAIL" =~ ^[^@]+@[^@]+\.[^@]+$ ]] || die "Invalid email." "ایمیل نامعتبر."
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    local pw
    read -r -s -p "  Admin password (empty = generate): " pw; say ""
    ADMIN_PASSWORD="$pw"
  fi
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
  apt-get update -y || die "apt-get update failed. Check network/DNS." "به‌روزرسانی apt ناموفق بود."
  apt-get install -y --no-install-recommends \
    ca-certificates curl unzip jq sqlite3 openssh-client sshpass tar gnupg \
    systemd ufw openssl iproute2 || die "apt-get install failed." "نصب بسته‌ها ناموفق بود."
  for cmd in curl jq sshpass openssl; do
    command -v "$cmd" >/dev/null 2>&1 || die "Required command '$cmd' not found after install." \
                                           "دستور مورد نیاز '$cmd' پس از نصب یافت نشد."
  done
  ok "System packages installed." "بسته‌های سیستمی نصب شدند."
}

# ---------------------------------------------------------------------------
# Node.js (LTS >= 22 for --experimental-strip-types)
# ---------------------------------------------------------------------------
ensure_node() {
  if need_cmd node; then
    local v major
    v="$(node -v | tr -d 'v')"
    major="${v%%.*}"
    if (( major >= NODE_MIN_MAJOR )); then
      need_cmd npm || die "node exists but npm is missing." "npm یافت نشد."
      ok "Node.js $(node -v) detected." "Node.js $(node -v) یافت شد."
      return 0
    fi
    warn "Node.js $v is too old (>= 22 required). Installing LTS…" \
         "نسخه Node.js $v قدیمی است. در حال نصب…"
  fi
  export DEBIAN_FRONTEND=noninteractive
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1 \
    || die "NodeSource setup failed." "راه‌اندازی NodeSource ناموفق بود."
  apt-get install -y nodejs >/dev/null \
    || die "Node.js install failed." "نصب Node.js ناموفق بود."
  node -v | grep -q '^v2[2-9]' || die "Node.js install failed." "نصب Node.js ناموفق بود."
  ok "Node.js $(node -v) installed." "Node.js $(node -v) نصب شد."
}

# ---------------------------------------------------------------------------
# Swap (low-RAM hosts: npm ci + next build need headroom)
# ---------------------------------------------------------------------------
ensure_swap() {
  if [[ "$NO_SWAP" -eq 1 ]]; then
    note "Swap provisioning skipped (--no-swap)."
    return 0
  fi
  local mem_kb swap_kb
  mem_kb="$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  swap_kb="$(awk '/SwapTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  if (( mem_kb >= 1572864 )) || (( swap_kb >= 1048576 )); then
    note "Memory OK ($((mem_kb/1024))M RAM, $((swap_kb/1024))M swap); no swapfile needed."
    return 0
  fi
  local swapfile="/swapfile"
  if swapon --show=NAME 2>/dev/null | grep -qx "$swapfile"; then
    ok "Swapfile already active." "سواپ فعال است."
    return 0
  fi
  info "Low RAM ($((mem_kb/1024))M); provisioning 2G swapfile…" "رم کم است؛ ساخت سواپ…"
  local free_kb
  free_kb="$(df -k / 2>/dev/null | awk 'NR==2{print $4}')"
  if [[ -n "$free_kb" ]] && (( free_kb < 2621440 )); then
    warn "Not enough free disk for a 2G swapfile; continuing without swap (build may OOM)." \
         "فضای کافی برای سواپ نیست."
    return 0
  fi
  if fallocate -l 2G "$swapfile" 2>/dev/null || dd if=/dev/zero of="$swapfile" bs=1M count=2048 status=none 2>/dev/null; then
    chmod 600 "$swapfile"
    if mkswap "$swapfile" >/dev/null 2>&1 && swapon "$swapfile" 2>/dev/null; then
      grep -qx "$swapfile none swap sw 0 0" /etc/fstab 2>/dev/null || echo "$swapfile none swap sw 0 0" >>/etc/fstab
      ok "Swap active: $(free -m | awk '/Swap/{print $2}')M total." "سواپ فعال شد."
      return 0
    fi
    rm -f "$swapfile"
  fi
  warn "Could not enable swap (restricted environment?); continuing — build may OOM." \
       "فعال‌سازی سواپ ممکن نشد."
  return 0
}

# ---------------------------------------------------------------------------
# Tunnel binaries (backhaul / frpc+frps / gost)
# ---------------------------------------------------------------------------
ARCH="$(detect_arch)"
GO_ARCH=$([[ "$ARCH" == "amd64" ]] && echo "amd64" || echo "arm64")

latest_release() { # repo -> version tag (tag_name), "unknown" when unreachable
  local tag
  tag="$(curl -fsSL --connect-timeout 10 "https://api.github.com/repos/$1/releases/latest" 2>/dev/null \
        | jq -r '.tag_name' 2>/dev/null)"
  printf '%s' "${tag:-unknown}"
}

fetch_and_extract() { # url asset-name dst-dir bin-names...
  local url="$1" asset="$2" dst="$3"; shift 3
  local tmp; tmp="$(mktemp -d)"
  # NOTE: expand $tmp now — a single-quoted trap would see the local as
  # unbound when it fires on RETURN under `set -u`.
  trap "rm -rf '${tmp}'" RETURN
  curl -fL --retry 3 --connect-timeout 15 -o "$tmp/$asset" "$url" || return 1
  case "$asset" in
    *.tar.gz|*.tgz) tar -xzf "$tmp/$asset" -C "$tmp" || return 1;;
    *.zip)          unzip -q -o "$tmp/$asset" -d "$tmp" || return 1;;
  esac
  mkdir -p "$dst"
  local n found=0
  for n in "$@"; do
    if find "$tmp" -type f -name "$n" -exec cp {} "$dst/" \; >/dev/null 2>&1; then
      chmod +x "$dst/$n"; found=1
    fi
  done
  [[ $found -eq 1 ]] || return 1
}

install_binaries() {
  mkdir -p "$BIN_DIR"
  local bh_ver fp_ver gost_ver fails=0

  bh_ver="${BACKHAUL_VERSION:-$(latest_release Musixal/Backhaul)}"
  [[ "$bh_ver" == "unknown" ]] && bh_ver="v0.7.2"
  info "Installing backhaul $bh_ver…" "در حال نصب backhaul…"
  if fetch_and_extract \
      "$MIRROR/Musixal/Backhaul/releases/download/$bh_ver/backhaul_linux_${GO_ARCH}.tar.gz" \
      "backhaul_linux_${GO_ARCH}.tar.gz" "$BIN_DIR" backhaul; then
    ok "backhaul installed." "backhaul نصب شد."
  else
    warn "backhaul download failed; try BACKHAUL_VERSION=<tag> or XT_MIRROR." \
         "دانلود backhaul ناموفق بود."; fails=1
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
    warn "frp download failed; check FRP_VERSION=<tag>." "دانلود frp ناموفق بود."; fails=1
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
    warn "gost download failed; check GOST_VERSION=<tag>." "دانلود gost ناموفق بود."; fails=1
  fi

  ls -1 "$BIN_DIR" | sed 's/^/    /'
  [[ -n "$(ls -A "$BIN_DIR" 2>/dev/null)" ]] || \
    die "No binaries were installed. Provide network access or XT_MIRROR." \
        "هیچ باینری نصب نشد. دسترسی شبکه یا XT_MIRROR را فراهم کنید."
  [[ "$fails" -eq 0 ]] || warn "Some binaries failed; tunnels using them will error until installed." \
    "برخی باینری‌ها نصب نشدند."
}

# ---------------------------------------------------------------------------
# Secrets + env file (PORT is updated on re-runs; secrets are kept)
# ---------------------------------------------------------------------------
gen_hex()  { openssl rand -hex 32; }
gen_pass() { openssl rand -base64 18 | tr -d '/+=' | head -c 20; }

write_env() {
  mkdir -p "$ETC_DIR"
  if [[ -s "$ENV_FILE" ]]; then
    # Preserve secrets, refresh mutable settings (port/paths) on re-install.
    sed -i -E "s|^PORT=.*|PORT=${PANEL_PORT}|; s|^XT_DATA_DIR=.*|XT_DATA_DIR=${DATA_DIR}|; s|^XT_BIN_DIR=.*|XT_BIN_DIR=${BIN_DIR}|" "$ENV_FILE"
    grep -q '^PORT=' "$ENV_FILE" || echo "PORT=${PANEL_PORT}" >>"$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "Environment updated: $ENV_FILE (secrets preserved)" "فایل محیط به‌روز شد."
    return 0
  fi
  local enc jwt
  enc="$(gen_hex)"; jwt="$(gen_hex)"
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
  ok "Environment written: $ENV_FILE" "فایل محیط نوشته شد: $ENV_FILE"
}

# ---------------------------------------------------------------------------
# Panel build + deploy
# ---------------------------------------------------------------------------
build_panel() {
  [[ -f "$REPO_ROOT/package.json" ]] || die "Not a repo checkout. Use bootstrap.sh or clone first." \
                                            "این پوشه مخزن نیست."
  info "Installing dependencies…" "در حال نصب وابستگی‌ها…"
  ( cd "$REPO_ROOT" && npm ci --no-audit --no-fund 2>&1 | tail -3 ) \
    || die "npm ci failed (see output above)." "نصب وابستگی‌ها ناموفق بود."
  info "Building panel (this may take a few minutes)…" "در حال ساخت پنل…"
  export TURBO_DISABLE=true
  ( cd "$REPO_ROOT" && npm run build 2>&1 | tail -5 ) \
    || die "Panel build failed (see output above)." "ساخت پنل ناموفق بود."
  if [[ -d "$REPO_ROOT/apps/web/.next/standalone" ]]; then
    cp -r "$REPO_ROOT/apps/web/.next/static" \
          "$REPO_ROOT/apps/web/.next/standalone/apps/web/.next/static" 2>/dev/null || true
  else
    die "Build produced no standalone output." "خروجی standalone ساخته نشد."
  fi
  ok "Panel build complete." "ساخت پنل کامل شد."
}

deploy_panel() {
  backup_existing
  mkdir -p "$INSTALL_DIR" "$DATA_DIR" "$ETC_DIR"
  info "Deploying to $INSTALL_DIR…" "در حال استقرار در $INSTALL_DIR…"
  tar -C "$REPO_ROOT" --exclude=.git --exclude=.next --exclude=tunnels \
      --exclude='*.db' --exclude='*.db-journal' -cf - . \
    | tar -C "$INSTALL_DIR" -xf - \
    || die "Deploy copy failed." "کپی استقرار ناموفق بود."
  rm -rf "$INSTALL_DIR/apps/web/.next"
  cp -r "$REPO_ROOT/apps/web/.next" "$INSTALL_DIR/apps/web/.next" \
    || die "Could not copy build output." "کپی خروجی ساخت ناموفق بود."
  cp "$REPO_ROOT/packages/tunnel-core/src/forwarder-runner.ts" "$DATA_DIR/forwarder-runner.ts" \
    || die "Could not deploy forwarder-runner." "استقرار forwarder ناموفق بود."
  touch "$INSTALL_DIR/.bootstrap-ok" 2>/dev/null || true
  [[ -n "${XP_BOOTSTRAP_DIR:-}" ]] && touch "$XP_BOOTSTRAP_DIR/.bootstrap-ok" 2>/dev/null || true
  ok "Deployed to $INSTALL_DIR." "استقرار در $INSTALL_DIR کامل شد."
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
init_db() {
  local admin_email="${ADMIN_EMAIL:-admin@xistance.local}"
  local admin_pass="${ADMIN_PASSWORD:-$(gen_pass)}"
  local generated=0
  [[ -n "${ADMIN_PASSWORD:-}" ]] || generated=1
  info "Initialising database…" "در حال مقداردهی پایگاه‌داده…"
  local dbdir="$INSTALL_DIR/packages/db"
  [[ -d "$dbdir" ]] || die "Deploy step missing ($dbdir). Re-run install." "استقرار ناقص است."
  (
    cd "$dbdir" || exit 1
    set -a; . "$ENV_FILE"; set +a
    npx prisma db push --accept-data-loss --skip-generate >/dev/null 2>&1 \
      || { npx prisma generate >/dev/null 2>&1 \
           && npx prisma db push --accept-data-loss >/dev/null 2>&1; } \
      || exit 1
    XT_ADMIN_EMAIL="$admin_email" XT_ADMIN_PASSWORD="$admin_pass" \
      npx prisma db seed >/dev/null 2>&1 || exit 1
  ) || die "Database init/seed failed." "مقداردهی پایگاه‌داده ناموفق بود."
  ok "Database ready. Admin: $admin_email" \
     "پایگاه‌داده آماده است. مدیر: $admin_email"
  if [[ "$generated" -eq 1 ]]; then
    say ""
    printf '%s%s%s\n' "$C_YEL" "  Initial admin password: $admin_pass" "$C_RST"
    printf '%s\n' "  رمز عبور اولیه مدیر: $admin_pass"
    say "  (Save it now — it is not shown again. / هم‌اکنون ذخیره کنید.)"
    say ""
  fi
}

# ---------------------------------------------------------------------------
# systemd
# ---------------------------------------------------------------------------
install_systemd() {
  local server_js="$INSTALL_DIR/apps/web/.next/standalone/apps/web/server.js"
  [[ -f "$server_js" ]] || server_js="$INSTALL_DIR/apps/web/server.js"
  [[ -f "$server_js" ]] || die "Server bundle missing ($server_js)." "باندل سرور یافت نشد."
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
  systemctl daemon-reload || die "systemctl daemon-reload failed (no systemd?)." "systemd در دسترس نیست."
  systemctl enable xistance.service >/dev/null 2>&1 || true
  systemctl restart xistance.service || die "xistance.service failed to start. See: journalctl -u xistance -n 50" \
    "سرویس شروع نشد. لاگ: journalctl -u xistance -n 50"
  ok "Panel service installed + started (xistance.service)." \
     "سرویس پنل نصب و راه‌اندازی شد (xistance.service)."
}

# ---------------------------------------------------------------------------
# Firewall
# ---------------------------------------------------------------------------
firewall_wizard() {
  [[ $SKIP_FIREWALL -eq 1 ]] && { warn "Firewall skipped." "فایروال نادیده گرفته شد."; return 0; }
  if [[ "$MODE" == "panel" ]] && need_cmd ufw && systemctl is-active ufw >/dev/null 2>&1; then
    ufw allow "$PANEL_PORT"/tcp >/dev/null 2>&1 || warn "ufw allow $PANEL_PORT failed." "باز کردن پورت ناموفق بود."
    if [[ $NONINTERACTIVE -eq 0 ]]; then
      say ""
      local ans range
      read -r -p "Open extra TCP range for tunnels (e.g. 30000-40000)? [N/y] " ans
      if [[ "${ans,,}" == "y" ]]; then
        read -r -p "Port range: " range
        ufw allow "$range"/tcp >/dev/null 2>&1 || warn "ufw allow $range failed." "باز کردن بازه ناموفق بود."
      fi
    fi
    ok "Firewall: opened port $PANEL_PORT." "فایروال: پورت $PANEL_PORT باز شد."
  else
    note "ufw not active; skipping firewall rules (use --skip-firewall to silence)."
  fi
}

# ---------------------------------------------------------------------------
# Health check verification
# ---------------------------------------------------------------------------
verify_installation() {
  info "Verifying installation…" "در حال بررسی نصب…"
  local retries=10 delay=3 i
  for ((i=1; i<=retries; i++)); do
    if curl -sf "http://127.0.0.1:${PANEL_PORT}/api/health" >/dev/null 2>&1; then
      ok "Health check passed." "بررسی سلامت موفقیت‌آمیز بود."
      return 0
    fi
    sleep "$delay"
  done
  log "Health check failed; last service state: $(systemctl is-active xistance.service 2>/dev/null || echo unknown)"
  return 1
}

# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------
show_status() {
  # Read the installed port (CLI default 8080 is wrong for custom installs).
  if [[ -f "$ENV_FILE" ]]; then
    set -a; . "$ENV_FILE"; set +a
    [[ -n "${PORT:-}" ]] && PANEL_PORT="$PORT"
  fi
  say ""
  say "  Xistance Panel — status / وضعیت"
  printf '  Service : %s\n' "$(systemctl is-active xistance.service 2>/dev/null || echo "unknown (no systemd?)")"
  if curl -sf "http://127.0.0.1:${PANEL_PORT}/api/health" 2>/dev/null | head -c 300; then
    say ""; ok "Panel healthy on port $PANEL_PORT." "پنل سالم است."
  else
    warn "Panel not responding on port $PANEL_PORT." "پنل پاسخ نمی‌دهد."
  fi
  exit 0
}

# ---------------------------------------------------------------------------
# Node mode (remote VPS bootstrap)
# ---------------------------------------------------------------------------
install_node_mode() {
  run_step preflight preflight
  run_step deps install_deps
  run_step node ensure_node
  run_step binaries install_binaries
  if [[ $SKIP_FIREWALL -eq 0 ]] && need_cmd ufw; then
    if [[ $NONINTERACTIVE -eq 0 ]]; then
      local ans r
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
# Interactive menu (process control)
# ---------------------------------------------------------------------------
show_menu() {
  need_root
  local scripts_dir="$REPO_ROOT/scripts"
  while true; do
    banner
    say "  Process control / کنترل فرآیند:"
    say "   1) Install panel          نصب پنل"
    say "   2) Prep node binaries     آماده‌سازی باینری گره"
    say "   3) Update panel           به‌روزرسانی پنل"
    say "   4) Service status         وضعیت سرویس"
    say "   5) Restart service        راه‌اندازی مجدد سرویس"
    say "   6) View logs              مشاهده لاگ‌ها"
    say "   7) Backup now             پشتیبان‌گیری"
    say "   8) Rollback               بازگشت به نسخه قبل"
    say "   9) Uninstall              حذف نصب"
    say "   0) Quit                   خروج"
    say ""
    local c
    read -r -p "  Select [0-9]: " c
    case "$c" in
      1) MODE="panel"; run_install;;
      2) local m; read -r -p "  Node type [iran/foreign]: " m; MODE="$m"; install_node_mode;;
      3) bash "$scripts_dir/update.sh" --branch "$BRANCH";;
      4) systemctl status xistance.service --no-pager 2>/dev/null | head -20 || warn "No systemd service." "سرویسی نیست.";;
      5) systemctl restart xistance.service && ok "Restarted." "مجدداً راه‌اندازی شد.";;
      6) journalctl -u xistance.service -n 50 --no-pager 2>/dev/null || warn "No logs." "لاگی نیست.";;
      7) bash "$scripts_dir/backup.sh";;
      8) do_rollback;;
      9) local p; read -r -p "  Also purge data? [y/N]: " p
         [[ "${p,,}" == "y" ]] && bash "$scripts_dir/uninstall.sh" --purge || bash "$scripts_dir/uninstall.sh";;
      0) say "Bye."; exit 0;;
      *) warn "Invalid choice." "انتخاب نامعتبر.";;
    esac
    say ""; read -r -p "  Press Enter to continue…" _
  done
}

# ---------------------------------------------------------------------------
# Panel install flow
# ---------------------------------------------------------------------------
step_func() { # <step> -> function name
  case "$1" in
    preflight) echo preflight;;
    deps) echo install_deps;;
    node) echo ensure_node;;
    swap) echo ensure_swap;;
    binaries) echo install_binaries;;
    env) echo write_env;;
    build) echo build_panel;;
    deploy) echo deploy_panel;;
    db) echo init_db;;
    systemd) echo install_systemd;;
    firewall) echo firewall_wizard;;
    verify) echo verify_installation;;
  esac
}

run_install() {
  banner
  if [[ -n "$ONLY_STEP" ]]; then
    run_step "$ONLY_STEP" "$(step_func "$ONLY_STEP")"
    ok "Step '$ONLY_STEP' done." "گام «$ONLY_STEP» انجام شد."
    return 0
  fi
  collect_inputs
  local s
  for s in "${STEPS[@]}"; do
    run_step "$s" "$(step_func "$s")"
  done
  say ""
  ok "Installation complete." "نصب با موفقیت کامل شد."
  say "  Panel:  http://<server-ip>:${PANEL_PORT}"
  say "  پنل:    http://<ip-سرور>:${PANEL_PORT}"
  say "  Logs:   ${LOG_FILE}  ·  Service: journalctl -u xistance -f"
  say "  Backup: bash scripts/backup.sh  ·  Resume: re-run this same command"
  say ""
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  [[ $SHOW_STATUS -eq 1 ]] && show_status
  [[ $ROLLBACK -eq 1 ]] && { need_root; do_rollback; }
  [[ $SHOW_MENU -eq 1 ]] && show_menu

  case "$MODE" in
    panel) run_install;;
    iran|foreign) install_node_mode;;
  esac
}

main "$@"
