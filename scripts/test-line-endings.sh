#!/usr/bin/env bash
#
# Line-ending and shell-portability guard (regression test for a real outage).
#
# A shell script with CRLF endings fails on Linux before it runs a single line:
#
#   set: pipefail\r: invalid option name
#   syntax error near unexpected token `$'{\r''
#
# That is not a cosmetic warning — it means the one-line installer, the update
# script and the migration applier cannot execute on the target host at all. It
# reached a real Ubuntu server before this test existed.
#
# .gitattributes already declares `*.sh text eol=lf`, so a fresh checkout is
# correct. This guards the working tree, which can drift from that attribute.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0
ok()  { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }

printf '\n=== line endings and shell portability ===\n'

# Every shell script and every shipped .mjs must be LF-only.
cd "$REPO_ROOT" || exit 1
mapfile -t TARGETS < <(
  find scripts -type f \( -name '*.sh' -o -name '*.mjs' \) -not -path '*/node_modules/*' | sort
)

if [[ "${#TARGETS[@]}" -gt 0 ]]; then
  ok "found ${#TARGETS[@]} shell/mjs scripts to check"
else
  bad "found ${#TARGETS[@]} shell/mjs scripts to check"
fi

for file in "${TARGETS[@]}"; do
  if LC_ALL=C grep -qU $'\r' "$file"; then
    bad "$file has CRLF line endings (it will not run on Linux)"
  else
    ok "$file is LF-only"
  fi
done

# A CRLF script must be *detected* as broken, proving the check above works.
CRLF_PROBE="$SCRIPT_DIR/.eol-probe.sh"
printf '#!/usr/bin/env bash\r\necho probe\r\n' > "$CRLF_PROBE"
if LC_ALL=C grep -qU $'\r' "$CRLF_PROBE"; then
  ok "the CRLF check detects a CRLF file (non-vacuous)"
else
  bad "the CRLF check detects a CRLF file (non-vacuous)"
fi
rm -f "$CRLF_PROBE"

# Every shell script must parse. A CRLF file fails here too, which is the
# failure the VPS actually produced.
for file in "${TARGETS[@]}"; do
  case "$file" in
    *.sh)
      if bash -n "$file" 2>/dev/null; then
        ok "$file parses"
      else
        bad "$file does not parse"
      fi
      ;;
  esac
done

# Shell scripts that ship to a host must not depend on bash-only behaviour that
# the target may lack. `set -euo pipefail` is fine on Ubuntu; a shebang of
# /bin/sh with bash syntax is not.
for file in "${TARGETS[@]}"; do
  case "$file" in
    *.sh)
      shebang="$(head -1 "$file" 2>/dev/null || true)"
      if [[ "$shebang" == "#!/usr/bin/env bash" || "$shebang" == "#!/bin/bash" ]]; then
        ok "$file declares a bash shebang"
      else
        bad "$file declares a bash shebang (found: ${shebang:-none})"
      fi
      ;;
  esac
done

# The install/update scripts are the ones a user runs on the host, so their
# line endings are called out explicitly.
for critical in scripts/release-install.sh scripts/update.sh scripts/install.sh scripts/apply-migrations.mjs; do
  if [[ -f "$critical" ]]; then
    if LC_ALL=C grep -qU $'\r' "$critical"; then
      bad "critical script $critical is LF-only"
    else
      ok "critical script $critical is LF-only"
    fi
  fi
done

printf '\n--- %d passed, %d failed ---\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
