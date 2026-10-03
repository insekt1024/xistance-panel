#!/usr/bin/env bash
#
# Release-payload coverage on a Linux host (TASK-83).
#
# WHY THIS EXISTS, AND WHY IT IS NOT PART OF THE AGGREGATE
# -------------------------------------------------------
# `test-artifact-assets.ts` picks its tree from a preference-ordered list:
#
#     dist/artifact-local   a fixture staged with this host's Prisma engine
#     dist/artifact         the real single-architecture release payload
#     .next/standalone      a build intermediate
#
# On Windows the FIRST candidate is the only one that can boot, so the fixture
# wins and `dist/artifact` is never exercised. The suite reported green against
# a tree staged hours before the release was rebuilt, and `artifactCovered: true`
# in the gate verdict did not distinguish the two. That is silent drift: the
# artifact that ships had no asset or localization coverage.
#
# This script closes that gap by running the SAME suite against the REAL payload
# on a Linux x64 host, where the Debian query engine it ships is loadable. It is
# deliberately separate from `run-browser-gate.ts`: that gate's artifact check
# legitimately prefers the local fixture, and reordering it would break the
# Windows path without adding coverage here.
#
# WHAT IT DOES NOT DO
# -------------------
# It does not weaken or bypass the architecture guard. If the payload ships an
# engine this host cannot load, the suite exits with its own explanation (exit
# 77, "could not run here") and that is recorded as SKIP, never as PASS.
#
# USAGE
#   bash scripts/test-release-payload-linux.sh [artifactRoot]
#
# Requires: a Linux x64 host with node >= 20 that can reach the repository and
# the staged payload. Exit 0 = covered, 77 = skipped (wrong platform), other =
# failed.

set -uo pipefail

# REPO is derived from this script's own location, which is correct when it is
# run in place and WRONG when the aggregate copies it out to a scratch root
# (`$HOME/xt-gate/gate.sh`), where it would resolve to /root and find no
# node_modules. So the real repository root can be supplied by the caller, and
# a copy with no root supplied says so rather than failing on a missing
# compiler three steps later.
REPO="${XT_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ARTIFACT="${1:-$REPO/dist/artifact}"

# ---------------------------------------------------------------------------
# 0. Platform gate. Probed, not assumed.
# ---------------------------------------------------------------------------
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64|Linux/amd64) ;;
  *)
    echo "SKIP: needs Linux x86_64 (this is $(uname -s)/$(uname -m))." >&2
    echo "      The payload is single-architecture; testing it elsewhere tests nothing." >&2
    exit 77
    ;;
esac

command -v node >/dev/null 2>&1 || { echo "SKIP: no node on PATH." >&2; exit 77; }

if [[ ! -f "$ARTIFACT/apps/web/server.js" ]]; then
  echo "FAIL: $ARTIFACT is not a staged release payload (no apps/web/server.js)." >&2
  exit 1
fi

# A payload with no architecture-specific engine is not the artifact we mean.
if ! compgen -G "$ARTIFACT/packages/db/generated/client/libquery_engine-*" >/dev/null; then
  echo "FAIL: $ARTIFACT ships no libquery_engine for this platform." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. os.tmpdir() follows TEMP, which Windows exports into WSL. Left alone it
#    yields "C:\Windows\Temp/..." and every mkdtemp fails with ENOENT.
# ---------------------------------------------------------------------------
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/xt-release-payload.XXXXXX")" || exit 1
# mktemp can succeed and still print nothing under an odd TMPDIR. An empty
# SCRATCH would silently redirect every later path to /js, which tsc reports as
# "EACCES: permission denied, mkdir '/js'" -- an error that points at the
# filesystem rather than at the empty variable that caused it.
if [[ -z "$SCRATCH" || ! -d "$SCRATCH" ]]; then
  echo "FAIL: could not create a scratch directory (TMPDIR=${TMPDIR:-unset})" >&2
  exit 1
fi
cleanup() { rm -rf "$SCRATCH"; }
trap cleanup EXIT
export TMPDIR="$SCRATCH" TEMP="$SCRATCH" TMP="$SCRATCH"

# tsc resolves a relative --outDir against its own cwd, not the shell's, and
# the repo root is not writable in every invocation context. Absolute from here.
COMPILED="$SCRATCH/js"

# ---------------------------------------------------------------------------
# 2. Compile on the platform that owns node_modules.

#    The compiler must be resolved explicitly: see the note at the call site.
TSC="$REPO/node_modules/typescript/bin/tsc"
if [[ ! -f "$TSC" ]]; then
  echo "FAIL: no local TypeScript compiler at node_modules/typescript/bin/tsc" >&2
  echo "      run 'npm install' on the platform that owns node_modules" >&2
  exit 1
fi

#
#    `tsx` cannot run here: the repository's node_modules was installed on
#    Windows, so node_modules/esbuild is a Windows binary and fails to exec. The
#    suite is plain TypeScript, so compile it and run the emitted JS with this
#    host's node.
#
#    CommonJS is required, not a preference: the package "type" is commonjs, and
#    an ESM emit leaves extensionless imports like "./lib/staged-app"
#    unresolvable at runtime.
# Root-safety: the aggregate runs shell suites as root, and root's PATH has no
# repository node_modules, so bare `npx tsc` falls through to a NETWORK install
# and dies with "npm ERR! network" -- an error that mentions nothing about
# typescript. An explicit path turns that into an actionable message.
if ! (cd "$REPO" && node "$TSC" scripts/test-artifact-assets.ts \
        --outDir "$COMPILED" --module commonjs --target es2022 \
        --moduleResolution node --skipLibCheck --esModuleInterop \
        --resolveJsonModule) >"$SCRATCH/tsc.log" 2>&1; then
  # TS5096 (allowImportingTsExtensions) is emitted alongside valid JS and does
  # not stop output; only fail when no JavaScript was produced.
  if [[ ! -f "$COMPILED/test-artifact-assets.js" ]]; then
    echo "FAIL: could not compile the suite." >&2
    tail -5 "$SCRATCH/tsc.log" >&2
    exit 1
  fi
fi
[[ -f "$COMPILED/test-artifact-assets.js" ]] || { echo "FAIL: no emitted suite." >&2; exit 1; }

# ---------------------------------------------------------------------------
# 3. Run it against the REAL payload.
# ---------------------------------------------------------------------------
echo "artifact under test: $ARTIFACT"
set +e
XT_ASSET_ARTIFACT="$ARTIFACT" node "$COMPILED/test-artifact-assets.js"
RC=$?
set -e

# The suite's own architecture guard exits 77; that is a skip, not a pass.
if [[ $RC -eq 77 ]]; then
  echo "SKIP: the suite declined to run on this platform (exit 77)." >&2
  exit 77
fi
exit $RC