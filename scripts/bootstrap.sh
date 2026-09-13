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
#   --repo <URL>        git repo (default: $XT_MIRROR or github.com/insekt1024/xistance-panel.git)
#   --branch <NAME>     branch/tag to install, e.g. v1.1.2 (default: master)
#   --workdir <DIR>     reuse an existing checkout dir instead of temp
#   --help              show install.sh help
#
# --repo/--branch are also forwarded to install.sh so later menu-driven
# updates pull the same source. XT_MIRROR switches every download
# (checkout, tarball and binaries) to a mirror base.
#
set -uo pipefail

# Mirror-aware hosts: install.sh already honours XT_MIRROR for binary
# downloads, so the checkout itself must use it too — otherwise hosts that
# need a mirror fail before install.sh ever runs.
GH_BASE="${XT_MIRROR:-https://github.com}"
GH_BASE="${GH_BASE%/}"

REPO_URL="${GH_BASE}/insekt1024/xistance-panel.git"
BRANCH="master"
WORKDIR=""
CUSTOM_REPO=0

ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) REPO_URL="${2:-}"; CUSTOM_REPO=1; shift 2;;
    --repo=*) REPO_URL="${1#*=}"; CUSTOM_REPO=1; shift;;
    --branch) BRANCH="${2:-}"; shift 2;;
    --branch=*) BRANCH="${1#*=}"; shift;;
    --workdir) WORKDIR="${2:-}"; shift 2;;
    --workdir=*) WORKDIR="${1#*=}"; shift;;
    *) ARGS+=("$1"); shift;;
  esac
done

# Tarball fallback shapes depend on the host:
# - github (or a mirror serving the same paths): heads/ then tags/ (releases
#   like v1.1.2 are tags, and heads/<tag>.tar.gz 404s).
# - any other custom --repo: path shapes are unknown, git-only (no fallback).
tarball_urls() {
  if [[ "$CUSTOM_REPO" -eq 1 && "$REPO_URL" != *github.com* ]]; then
    return 0
  fi
  local base="$GH_BASE/insekt1024/xistance-panel"
  if [[ "$CUSTOM_REPO" -eq 1 ]]; then
    base="${REPO_URL%.git}"
  fi
  printf '%s\n' \
    "$base/archive/refs/heads/${BRANCH}.tar.gz" \
    "$base/archive/refs/tags/${BRANCH}.tar.gz"
}

# Re-exec as root so install.sh never has to ask for sudo mid-run. sudo -E
# preserves the caller's environment, which is how version pins
# (XRAY_VERSION/BACKHAUL_VERSION/FRP_VERSION/GOST_VERSION) and XT_* settings
# reach install.sh. Forward --repo/--branch too, so a later menu-driven
# `update` pulls the same source we installed from instead of drifting.
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Re-executing as root via sudo…"
  SUDO_ARGS=(bash "$0" --repo "$REPO_URL" --branch "$BRANCH")
  [[ -n "$WORKDIR" ]] && SUDO_ARGS+=(--workdir "$WORKDIR")
  SUDO_ARGS+=("${ARGS[@]}")
  exec sudo -E "${SUDO_ARGS[@]}"
fi

need_cmd() { command -v "$1" >/dev/null 2>&1; }
need_cmd curl || { echo "curl is required to bootstrap the installer." >&2; exit 1; }
need_cmd tar || { echo "tar is required to bootstrap the installer." >&2; exit 1; }

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

if [[ -f "$WORKDIR/scripts/install.sh" ]]; then
  echo "Reusing existing checkout at $WORKDIR"
else
  if need_cmd git; then
    echo "Cloning $REPO_URL (branch $BRANCH)…"
    rm -rf "$WORKDIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$WORKDIR" \
      || { echo "git clone failed, falling back to tarball…" >&2; rm -rf "$WORKDIR"; mkdir -p "$WORKDIR"; }
  fi
  if [[ ! -f "$WORKDIR/scripts/install.sh" ]]; then
    downloaded=0
    while IFS= read -r url; do
      [[ -z "$url" ]] && continue
      echo "Downloading tarball $url…"
      mkdir -p "$WORKDIR"
      if curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 \
          -o "$WORKDIR/src.tar.gz" "$url"; then
        if tar -xzf "$WORKDIR/src.tar.gz" -C "$WORKDIR" --strip-components=1; then
          downloaded=1
          rm -f "$WORKDIR/src.tar.gz"
          break
        fi
        echo "Tarball from $url is corrupt, trying next…" >&2
        rm -f "$WORKDIR/src.tar.gz"
      else
        echo "Download from $url failed, trying next…" >&2
      fi
    done < <(tarball_urls)
    [[ "$downloaded" -eq 1 ]] || echo "All tarball URLs failed." >&2
  fi
fi

[[ -f "$WORKDIR/scripts/install.sh" ]] \
  || { echo "Could not obtain a valid checkout of $REPO_URL (branch $BRANCH) in $WORKDIR." >&2; exit 1; }

export XP_BOOTSTRAP_DIR="$WORKDIR"
# Keep install.sh on the same source: it accepts --repo/--branch for its
# menu-driven update path, and the checkout above is authoritative.
exec bash "$WORKDIR/scripts/install.sh" \
  --repo "$REPO_URL" --branch "$BRANCH" "${ARGS[@]}"
