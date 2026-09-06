#!/usr/bin/env bash
#
# Xistance Panel — bootstrap.sh (remote entry point)
#
# Downloads the installer checkout (git clone, or tarball fallback) into a
# temp dir and executes scripts/install.sh with all arguments forwarded.
# Downloading to a file first (instead of `curl | bash`) keeps CLI flags,
# interactive prompts, `--resume` and `--menu` working.
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/insekt1024/xistance-panel/master/scripts/bootstrap.sh \
#     -o /tmp/xp-install.sh && sudo bash /tmp/xp-install.sh --port 8080 \
#     --admin-email you@example.com
#
# Bootstrap-only options (consumed here, rest forwarded to install.sh):
#   --repo <URL>        git repo (default: https://github.com/insekt1024/xistance-panel.git)
#   --branch <NAME>     branch/tag to install (default: master)
#   --workdir <DIR>     reuse an existing checkout dir instead of temp
#   --help              show install.sh help
#
set -uo pipefail

REPO_URL="https://github.com/insekt1024/xistance-panel.git"
BRANCH="master"
WORKDIR=""
REPO_TARBALL="https://github.com/insekt1024/xistance-panel/archive/refs/heads/master.tar.gz"

ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_URL="${2:-}"; shift 2;;
    --repo=*) REPO_URL="${1#*=}"; shift;;
    --branch) BRANCH="${2:-}"; REPO_TARBALL=""; shift 2;;
    --branch=*) BRANCH="${1#*=}"; REPO_TARBALL=""; shift;;
    --workdir) WORKDIR="${2:-}"; shift 2;;
    --workdir=*) WORKDIR="${1#*=}"; shift;;
    *) ARGS+=("$1"); shift;;
  esac
done

[[ -z "$REPO_TARBALL" ]] && \
  REPO_TARBALL="https://github.com/insekt1024/xistance-panel/archive/refs/heads/${BRANCH}.tar.gz"

# Re-exec as root so install.sh never has to ask for sudo mid-run.
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Re-executing as root via sudo…"
  exec sudo -E bash "$0" --repo "$REPO_URL" --branch "$BRANCH" ${WORKDIR:+--workdir "$WORKDIR"} "${ARGS[@]}"
fi

need_cmd() { command -v "$1" >/dev/null 2>&1; }
need_cmd curl || { echo "curl is required to bootstrap the installer." >&2; exit 1; }

TMPDIR_CREATED=0
if [[ -z "$WORKDIR" ]]; then
  WORKDIR="$(mktemp -d /tmp/xistance-install.XXXXXX)"
  TMPDIR_CREATED=1
fi

cleanup() {
  # Keep the checkout on failure for debugging; remove only clean temp dirs
  # when the install reported success (install.sh touches $WORKDIR/.bootstrap-ok).
  if [[ "$TMPDIR_CREATED" -eq 1 && -f "$WORKDIR/.bootstrap-ok" ]]; then
    rm -rf "$WORKDIR"
  elif [[ "$TMPDIR_CREATED" -eq 1 ]]; then
    echo "Checkout kept at $WORKDIR for debugging. Re-run with --workdir $WORKDIR to resume."
  fi
}
trap cleanup EXIT

if [[ -x "$WORKDIR/scripts/install.sh" ]]; then
  echo "Reusing existing checkout at $WORKDIR"
else
  if need_cmd git; then
    echo "Cloning $REPO_URL (branch $BRANCH)…"
    rm -rf "$WORKDIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$WORKDIR" \
      || { echo "git clone failed, falling back to tarball…" >&2; rm -rf "$WORKDIR"; mkdir -p "$WORKDIR"; }
  fi
  if [[ ! -x "$WORKDIR/scripts/install.sh" ]]; then
    echo "Downloading tarball $REPO_TARBALL…"
    mkdir -p "$WORKDIR"
    curl -fL --retry 3 --connect-timeout 15 -o "$WORKDIR/src.tar.gz" "$REPO_TARBALL"
    tar -xzf "$WORKDIR/src.tar.gz" -C "$WORKDIR" --strip-components=1
    rm -f "$WORKDIR/src.tar.gz"
  fi
fi

[[ -x "$WORKDIR/scripts/install.sh" ]] \
  || { echo "Could not obtain a valid checkout in $WORKDIR." >&2; exit 1; }

export XP_BOOTSTRAP_DIR="$WORKDIR"
exec bash "$WORKDIR/scripts/install.sh" "${ARGS[@]}"
