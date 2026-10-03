#!/usr/bin/env bash
#
# Contract tests for the generated systemd unit and the migration contract
# (TASK-15).
#
# A unit file is not a shell script: a newline in a value silently starts a new
# directive, and a stray space changes ExecStart's argument splitting. These
# tests render the unit from hostile inputs and assert the result cannot gain a
# directive the template never intended.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$REPO_ROOT/scripts/xistance.service.template"

PASS=0
FAIL=0
ok()  { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n' "$1"; FAIL=$((FAIL + 1)); }

# Render the unit through the *real* shared library, so the thing under test is
# the thing the installers use.
#
# The library refuses values containing a newline rather than escaping them, so
# the marker file means the value was not sanitised.
# shellcheck source=lib/service-unit.sh
source "$REPO_ROOT/scripts/lib/service-unit.sh"
render_unit() {
  local env_file="$1" release_root="$2" node_bin="$3" description="$4" out="$5"
  if ! xt_render_service_unit "$env_file" "$release_root" "$node_bin" "xistance" "$description" \
       > "$out" 2>"$WORK/render.err"; then
    printf 'REFUSED\n' > "$out"
    return 0
  fi
}

# Values that must never be able to introduce a new directive.
HOSTILE_NEWLINE='xistance
ExecStart=/bin/sh -c "id > /tmp/pwned"'
HOSTILE_QUOTE='x"istance'"'"'s'
HOSTILE_SPACE='/opt/xistance current/apps/web/server.js'
HOSTILE_BRACE='/opt/${EVIL}/current'
HOSTILE_BACKSLASH='/opt/xistance\current'

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

printf '\n=== systemd unit contract (TASK-15) ===\n'

# ---------------------------------------------------------------------------
# 1. The template must be renderable and structurally sound.
# ---------------------------------------------------------------------------
printf '\n-- template structure --\n'
if [[ -f "$TEMPLATE" ]]; then
  ok "a service template exists"
else
  bad "a service template exists"
fi

render_unit "/etc/xistance/xistance.env" "/opt/xistance/current" "/usr/bin/node" \
  "Xistance Tunnel Control Panel" "$WORK/base.unit"

for section in "[Unit]" "[Service]" "[Install]"; do
  if grep -qF "$section" "$WORK/base.unit"; then
    ok "the unit declares $section"
  else
    bad "the unit declares $section"
  fi
done

# The service must use the active pointer and an explicit environment file.
if grep -qE '^EnvironmentFile=' "$WORK/base.unit"; then
  ok "the unit sets an explicit EnvironmentFile"
else
  bad "the unit sets an explicit EnvironmentFile"
fi
if grep -qE '^ExecStart=' "$WORK/base.unit"; then
  ok "the unit sets an explicit ExecStart"
else
  bad "the unit sets an explicit ExecStart"
fi

# ---------------------------------------------------------------------------
# 2. Hostile values must not inject directives.
# ---------------------------------------------------------------------------
printf '\n-- injection resistance --\n'
assert_no_injection() {
  local label="$1" value="$2" slot="$3"
  local unit="$WORK/inject.unit"
  local before after

  case "$slot" in
    env)    render_unit "$value" "/opt/xistance/current" "/usr/bin/node" "Safe" "$unit" ;;
    root)   render_unit "/etc/xistance/xistance.env" "$value" "/usr/bin/node" "Safe" "$unit" ;;
    node)   render_unit "/etc/xistance/xistance.env" "/opt/xistance/current" "$value" "Safe" "$unit" ;;
    desc)   render_unit "/etc/xistance/xistance.env" "/opt/xistance/current" "/usr/bin/node" "$value" "$unit" ;;
  esac

  # A newline inside a value is the classic systemd injection: everything after
  # it becomes a new directive. The library refuses such a value outright, so
  # the only acceptable outcomes are a REFUSED marker or a unit that does not
  # contain the injected text.
  if grep -q 'REFUSED' "$unit"; then
    ok "$label: refused rather than written"
    return
  fi
  if printf '%s' "$value" | grep -q '/bin/sh' && grep -q '/bin/sh' "$unit"; then
    bad "$label: the injected command reached the unit"
    return
  fi

  # No injected shell execution may appear anywhere in the unit.
  if grep -E '^ExecStart=' "$unit" | grep -qE '/bin/(sh|bash)|sh -c|eval '; then
    bad "$label: injected a shell into ExecStart"
    return
  fi

  # The unit must still parse into the expected sections.
  if ! grep -qE '^\[Service\]$' "$unit"; then
    bad "$label: the [Service] section was lost"
    return
  fi

  # The number of directives must not have grown: an injected value may not add
  # any line that systemd would read as a directive.
  before="$(grep -cE '^[A-Za-z]' "$WORK/base.unit")"
  after="$(grep -cE '^[A-Za-z]' "$unit")"
  if [[ "$after" -gt "$before" ]]; then
    bad "$label: the unit gained $((after - before)) directive(s)"
    return
  fi

  ok "$label: no directive injection"
}

assert_no_injection "env file with newline"  "$HOSTILE_NEWLINE"  env
assert_no_injection "release root with newline" "$HOSTILE_NEWLINE" root
assert_no_injection "node bin with newline"  "$HOSTILE_NEWLINE"  node
assert_no_injection "description with newline" "$HOSTILE_NEWLINE" desc

# ---------------------------------------------------------------------------
# 3. Paths with spaces must be quoted, not split.
# ---------------------------------------------------------------------------
printf '\n-- quoting of paths containing spaces --\n'
render_unit "/etc/xistance/xistance.env" "$HOSTILE_SPACE" "/usr/bin/node" "Safe" "$WORK/space.unit"
# ExecStart is an argv list, so each argument is quoted there.
if grep -qE '^ExecStart="[^"]*"[[:space:]]+"[^"]*"' "$WORK/space.unit"; then
  ok "ExecStart quotes both the interpreter and the server path"
else
  bad "ExecStart quotes both the interpreter and the server path"
fi

# EnvironmentFile and WorkingDirectory must stay UNQUOTED. systemd does not
# strip quotes in those directives and rejects a quoted value as "path is not
# absolute", which makes the unit fatally invalid.
if grep -qE '^WorkingDirectory="' "$WORK/space.unit"; then
  bad "WorkingDirectory is not quoted (systemd rejects quoted paths there)"
else
  ok "WorkingDirectory is not quoted (systemd rejects quoted paths there)"
fi
if grep -qE '^EnvironmentFile="' "$WORK/space.unit"; then
  bad "EnvironmentFile is not quoted (systemd rejects quoted paths there)"
else
  ok "EnvironmentFile is not quoted (systemd rejects quoted paths there)"
fi
if grep -qE '^ExecStart="[^"]*"[[:space:]]+"[^"]*"' "$WORK/space.unit"; then
  ok "ExecStart quotes both the interpreter and the server path"
else
  bad "ExecStart quotes both the interpreter and the server path"
fi

# ---------------------------------------------------------------------------
# 3b. The unit must be startable by systemd itself.
#
# The quoted-path defect shipped because the unit was never handed to systemd.
# `systemd-analyze verify` is the authority: it reports a unit that systemd
# would refuse, exactly as the VPS did.
# ---------------------------------------------------------------------------
printf '\n-- systemd accepts the rendered unit --\n'
if command -v systemd-analyze >/dev/null 2>&1; then
  ok "systemd-analyze is available"
  # A stand-in for the release root, so verify sees a real absolute path.
  verify_root="$WORK/opt/xistance/current"
  mkdir -p "$verify_root/apps/web" "$WORK/etc/xistance"
  printf 'PORT=8080\n' > "$WORK/etc/xistance/xistance.env"
  : > "$verify_root/apps/web/server.js"
  # EnvironmentFile and WorkingDirectory must point at absolute paths.
  mkdir -p "$WORK/opt/xistance/current"
  if xt_render_service_unit "$WORK/etc/xistance/xistance.env" "$verify_root" \
       "$(command -v node)" "xistance" "Xistance" > "$WORK/verify.unit"; then
    ok "the unit renders for verification"
  else
    bad "the unit renders for verification"
  fi
  out="$(systemd-analyze verify "$WORK/verify.unit" 2>&1 || true)"
  if printf '%s' "$out" | grep -qiE 'not absolute|fatal|bad unit'; then
    bad "systemd-analyze accepts the unit"
    printf '     %s\n' "$(printf '%s' "$out" | head -3)"
  else
    ok "systemd-analyze accepts the unit"
  fi
else
  info "systemd-analyze is unavailable here; quoting rules are asserted statically instead"
fi

# ---------------------------------------------------------------------------
# 4. Brace and backslash expansion must not happen in the rendered unit.
# ---------------------------------------------------------------------------
printf '\n-- no late expansion --\n'
# A `${VAR}` in a path must be written literally. systemd performs no shell
# expansion, so a literal `${EVIL}` is inert; the danger would be the installer
# expanding it during generation.
render_unit "/etc/xistance/xistance.env" '$HOSTILE_BRACE' "/usr/bin/node" "Safe" "$WORK/brace.unit"
if grep -qF '$HOSTILE_BRACE' "$WORK/brace.unit" || grep -qF '{EVIL}' "$WORK/brace.unit"; then
  ok "a \${...} in a path is preserved literally, not expanded"
else
  bad "a \${...} in a path is preserved literally, not expanded"
  printf '     rendered: %s\n' "$(grep -E '^WorkingDirectory=' "$WORK/brace.unit")"
fi

# ---------------------------------------------------------------------------
# 5. The unit must not run as root.
#
# The template previously hardcoded User=root. A tunnel panel that can execute
# downloaded tunnel binaries and open listeners does not need root, and running
# it as root turns any code-execution bug into a full compromise.
# ---------------------------------------------------------------------------
printf '\n-- privilege --\n'
if grep -qE '^User=root$' "$WORK/base.unit"; then
  bad "the unit does not run as root"
else
  ok "the unit does not run as root"
fi
if grep -qE '^User=' "$WORK/base.unit"; then
  ok "the unit declares an explicit User"
else
  bad "the unit declares an explicit User"
fi

# The service account must be able to read the release and write its data dir,
# so the template must state the hardening that makes a non-root user work.
if grep -qE '^(ProtectSystem|ProtectHome|PrivateTmp|NoNewPrivileges)=' "$WORK/base.unit"; then
  ok "the unit carries at least one hardening directive"
else
  bad "the unit carries at least one hardening directive"
fi

# ---------------------------------------------------------------------------
# 6. Migration contract: run from the staged release, no build on the host.
# ---------------------------------------------------------------------------
printf '\n-- migration contract --\n'
UPDATE_SH="$REPO_ROOT/scripts/update.sh"
INSTALL_SH="$REPO_ROOT/scripts/release-install.sh"

for f in "$UPDATE_SH" "$INSTALL_SH"; do
  label="$(basename "$f")"
  if grep -qE 'apply-migrations\.mjs' "$f"; then
    ok "$label invokes the staged migration applier"
  else
    bad "$label invokes the staged migration applier"
  fi
  # Both scripts *document* that they avoid the Prisma CLI and any build chain.
  # Comments are stripped first, or that prose would read as a violation.
  code="$(sed -e 's/#.*$//' "$f" | perl -0777 -pe 's{/\*.*?\*/}{}gs')"
  if printf '%s' "$code" | grep -qE 'prisma (db push|migrate deploy)'; then
    bad "$label does not shell out to the Prisma CLI"
  else
    ok "$label does not shell out to the Prisma CLI"
  fi
  if printf '%s' "$code" | grep -qE 'npm (ci|install|run build)'; then
    bad "$label does not install or build on the host"
  else
    ok "$label does not install or build on the host"
  fi
done

# ---------------------------------------------------------------------------
# 7. Service control failures must be surfaced, not swallowed.
# ---------------------------------------------------------------------------
printf '\n-- service control failures are surfaced --\n'
# `|| true` on these calls is what made a broken unit look like a successful
# install, so their absence is the contract.
if grep -qE 'systemctl (daemon-reload|enable|restart)[^\n]*\|\| true' "$INSTALL_SH"; then
  bad "$REPO_ROOT/scripts/release-install.sh does not swallow systemctl failures"
else
  ok "release-install.sh does not swallow systemctl failures"
fi

# A non-existent systemctl must be reported, not silently skipped.
if grep -qE 'command -v systemctl' "$INSTALL_SH"; then
  ok "release-install.sh checks that systemd is present"
else
  bad "release-install.sh checks that systemd is present"
fi

printf '\n--- %d passed, %d failed ---\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
