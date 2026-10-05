#!/usr/bin/env bash
# Focused tests for the one-line version-pinned installer (TASK-13).
#
# The central claim of the zero-build goal is that the target host never
# compiles the panel. These tests assert that claim structurally against the
# real scripts, and exercise release-mode argument parsing in a sandbox.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_SH="$REPO_ROOT/scripts/install.sh"
BOOTSTRAP_SH="$REPO_ROOT/scripts/bootstrap.sh"
RELEASE_INSTALL_SH="$REPO_ROOT/scripts/release-install.sh"

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$1"; [[ $# -gt 1 ]] && printf '      %s\n' "$2"; }

printf '\n=== TASK-13: one-line version-pinned installer ===\n\n'

# ---------------------------------------------------------------------------
# The release installer exists and is a real entry point
# ---------------------------------------------------------------------------
printf 'Release entry point\n'
if [[ -f "$RELEASE_INSTALL_SH" ]]; then
  ok "scripts/release-install.sh exists"
else
  bad "scripts/release-install.sh exists" "the version-pinned installer is missing"
fi

if [[ -f "$RELEASE_INSTALL_SH" ]] && bash -n "$RELEASE_INSTALL_SH" 2>/dev/null; then
  ok "release-install.sh is syntactically valid bash"
else
  bad "release-install.sh is syntactically valid bash"
fi

# ---------------------------------------------------------------------------
# The install path must never compile on the target host
# ---------------------------------------------------------------------------
printf '\nNo source build on the target host\n'
# The build commands are only allowed inside an explicitly labelled source
# checkout, never in the release-install path. Comments are stripped first: the
# file documents that it does NOT build, and that prose must not read as a
# violation.
code_only() {
  # Drop full-line comments and trailing comments, then print the remainder.
  sed -e 's/#.*$//' "$1"
}

if code_only "$RELEASE_INSTALL_SH" | grep -qE '\bnpm (ci|install)\b'; then
  bad "release-install.sh must not run npm ci/install" \
      "$(code_only "$RELEASE_INSTALL_SH" | grep -nE '\bnpm (ci|install)\b' | head -3)"
else
  ok "release-install.sh must not run npm ci/install"
fi

if code_only "$RELEASE_INSTALL_SH" | grep -qE '\bnext build\b|npm run build'; then
  bad "release-install.sh must not run a Next.js build" \
      "$(code_only "$RELEASE_INSTALL_SH" | grep -nE '\bnext build\b|npm run build' | head -3)"
else
  ok "release-install.sh must not run a Next.js build"
fi

# bootstrap.sh must offer a release mode and only clone source when asked.
if grep -qE '\-\-release' "$BOOTSTRAP_SH"; then
  ok "bootstrap.sh exposes a --release mode"
else
  bad "bootstrap.sh exposes a --release mode"
fi

if grep -qE 'XT_SOURCE_CHECKOUT|--source' "$BOOTSTRAP_SH"; then
  ok "bootstrap.sh requires an explicit opt-in for a source checkout"
else
  bad "bootstrap.sh requires an explicit opt-in for a source checkout"
fi

# ---------------------------------------------------------------------------
# The release mode must pin a version and select an architecture
# ---------------------------------------------------------------------------
printf '\nVersion pin and architecture selection\n'
if [[ -f "$RELEASE_INSTALL_SH" ]]; then
  if grep -qE '\-\-version' "$RELEASE_INSTALL_SH"; then
    ok "release-install.sh accepts an explicit --version"
  else
    bad "release-install.sh accepts an explicit --version"
  fi

  # A pinned version must be mandatory: an unpinned "latest" install is not
  # reproducible, which is the whole point of a version-pinned installer.
  if grep -qE 'REFUSING|--version is required|must be provided' "$RELEASE_INSTALL_SH"; then
    ok "release-install.sh refuses an unpinned version"
  else
    bad "release-install.sh refuses an unpinned version"
  fi

  if grep -qE 'uname -m' "$RELEASE_INSTALL_SH"; then
    ok "release-install.sh detects the host architecture"
  else
    bad "release-install.sh detects the host architecture"
  fi

  if grep -qE 'amd64|arm64' "$RELEASE_INSTALL_SH"; then
    ok "release-install.sh maps to a supported release architecture"
  else
    bad "release-install.sh maps to a supported release architecture"
  fi

  # Unsupported architecture must be a hard failure, not a best guess.
  if grep -qE 'Unsupported architecture|unsupported architecture' "$RELEASE_INSTALL_SH"; then
    ok "release-install.sh rejects an unsupported architecture"
  else
    bad "release-install.sh rejects an unsupported architecture"
  fi

  # Verification before extraction is mandatory.
  if grep -qE 'verify-artifact|verify:artifact|verifyDownloadedArtifact' "$RELEASE_INSTALL_SH" \
     || grep -qE 'verify-artifact|release-manifest.ts verify' "$INSTALL_SH"; then
    ok "the install path invokes artifact verification"
  else
    bad "the install path invokes artifact verification"
  fi

  # Readiness check after activation.
  if grep -qE '/api/health' "$RELEASE_INSTALL_SH"; then
    ok "release-install.sh performs a readiness check"
  else
    bad "release-install.sh performs a readiness check"
  fi

  # A deploy whose database is never migrated, or which cannot create the first
  # account, is not an installable release.
  #
  # Assert the INVOCATION, not the word. `grep -qE 'apply-migrations'` matches
  # the file-existence guard on line 477 and the "artifact does not include
  # apply-migrations.mjs" die() message as well as the real call, so it stays
  # green after the call itself is deleted. Matching the node invocation
  # (quoted $NODE_BIN plus the applier path) is what the assertion is for.
  if grep -qE '^\s*"\$NODE_BIN" "\$CANDIDATE_DIR/apply-migrations\.mjs"' "$RELEASE_INSTALL_SH"; then
    ok "release-install.sh applies database migrations before activation"
  else
    bad "release-install.sh applies database migrations before activation"
  fi

  # ...and the applier must actually be given the database it migrates, not
  # invoked with no arguments (which would be a silent no-op).
  if grep -qE '^\s*--database "file:\$\{MIGRATION_DB\}"' "$RELEASE_INSTALL_SH" \
     && grep -qE '^\s*--migrations "\$CANDIDATE_DIR/packages/db/prisma/migrations"' "$RELEASE_INSTALL_SH"; then
    ok "release-install.sh passes the target database and migration set"
  else
    bad "release-install.sh passes the target database and migration set"
  fi

  # The database is CREATED by the migration, which runs as the installing
  # user (root on a real install). The installer's only chown of the data dir
  # happens earlier, while that directory is still empty, so on a FIRST
  # install app.db is left owned by root: the service user can read the schema
  # (/api/health answers 200) while every write fails with "attempt to write a
  # readonly database". Ownership must therefore be handed over AFTER the
  # migration has run.
  #
  # Asserting that a chown EXISTS is not enough -- the bug is its position, and
  # a chown placed before the migration reproduces the defect while satisfying
  # any presence check. Compare line numbers.
  _mig_line=$(grep -nE '^\s*"\$NODE_BIN" "\$CANDIDATE_DIR/apply-migrations\.mjs"' "$RELEASE_INSTALL_SH" | head -1 | cut -d: -f1)
  # The chown that matters re-asserts ownership of the whole data dir; the
  # earliest one is the pre-migration chown, so take the LAST matching line.
  _chown_line=$(grep -nE 'chown -R "\$SERVICE_USER":"\$SERVICE_USER" "\$DATA_DIR"' "$RELEASE_INSTALL_SH" | tail -1 | cut -d: -f1)
  if [ -n "$_mig_line" ] && [ -n "$_chown_line" ] && [ "$_chown_line" -gt "$_mig_line" ]; then
    ok "release-install.sh hands data-dir ownership to the service user AFTER migrations create the database"
  else
    bad "release-install.sh hands data-dir ownership to the service user AFTER migrations create the database" \
      "migration at line ${_mig_line:-?}, last data-dir chown at line ${_chown_line:-?} - a chown before the migration leaves app.db root-owned on a first install"
  fi

  # The call must be fatal on failure: a migration error that leaves the old
  # release active but the schema half-applied is worse than a clean abort.
  if grep -qE 'apply-migrations\.mjs" \\\s*$' "$RELEASE_INSTALL_SH" \
     && grep -qE '^\s*\|\| die "Database migration failed' "$RELEASE_INSTALL_SH"; then
    ok "a failed migration aborts activation instead of proceeding"
  else
    bad "a failed migration aborts activation instead of proceeding"
  fi
  if grep -qE 'create-admin' "$RELEASE_INSTALL_SH"; then
    ok "release-install.sh creates the initial administrator"
  else
    bad "release-install.sh creates the initial administrator"
  fi
fi

# ---------------------------------------------------------------------------
# A dry run must plan without installing anything
# ---------------------------------------------------------------------------
printf '\nDry run\n'
if [[ -f "$RELEASE_INSTALL_SH" ]] && grep -qE '\-\-dry-run' "$RELEASE_INSTALL_SH"; then
  ok "release-install.sh supports --dry-run"
else
  bad "release-install.sh supports --dry-run"
fi

if [[ -f "$RELEASE_INSTALL_SH" ]]; then
  # A dry run against a pinned version must succeed without network access and
  # must not create anything under the install root.
  sandbox="$(mktemp -d)"
  plan_out="$(
    bash "$RELEASE_INSTALL_SH" --version v9.9.9 --dry-run \
      --install-dir "$sandbox/opt" --data-dir "$sandbox/data" \
      --env-file "$sandbox/etc/xistance.env" 2>&1
  )"
  plan_rc=$?
  if [[ $plan_rc -eq 0 ]]; then
    ok "dry run plans successfully for a pinned version"
  else
    bad "dry run plans successfully for a pinned version" "rc=$plan_rc output: $(printf '%s' "$plan_out" | head -2)"
  fi
  if printf '%s' "$plan_out" | grep -qE 'v9\.9\.9'; then
    ok "dry run reports the pinned version"
  else
    bad "dry run reports the pinned version" "output: $(printf '%s' "$plan_out" | head -3)"
  fi
  if printf '%s' "$plan_out" | grep -qiE 'architecture|amd64|arm64'; then
    ok "dry run reports the selected architecture"
  else
    bad "dry run reports the selected architecture" "output: $(printf '%s' "$plan_out" | head -3)"
  fi
  if [[ ! -d "$sandbox/opt" ]]; then
    ok "dry run creates nothing under the install root"
  else
    bad "dry run creates nothing under the install root"
  fi
  rm -rf "$sandbox"
fi

# ---------------------------------------------------------------------------
# An unpinned version must fail without touching the system
# ---------------------------------------------------------------------------
printf '\nArgument validation\n'
if [[ -f "$RELEASE_INSTALL_SH" ]]; then
  sandbox="$(mktemp -d)"
  if bash "$RELEASE_INSTALL_SH" --dry-run \
      --install-dir "$sandbox/opt" --data-dir "$sandbox/data" \
      --env-file "$sandbox/etc/xistance.env" >/dev/null 2>&1; then
    bad "an unpinned version must be rejected"
  else
    ok "an unpinned version must be rejected"
  fi
  if bash "$RELEASE_INSTALL_SH" --help >/dev/null 2>&1; then
    ok "--help succeeds"
  else
    bad "--help succeeds"
  fi
  rm -rf "$sandbox"
fi

# ---------------------------------------------------------------------------
# Documented one-line command must pin a version
# ---------------------------------------------------------------------------
printf '\nDocumentation\n'
if grep -qE 'bootstrap\.sh.*--release|--release.*--version' "$REPO_ROOT/README.md" 2>/dev/null; then
  ok "README documents the pinned one-line command"
else
  bad "README documents the pinned one-line command"
fi

# ---------------------------------------------------------------------------
# Database init must not reach the network for the Prisma CLI.
#
# The release artifact ships the Prisma *client* and deliberately omits the
# CLI. An `npx prisma ...` in the install path resolves to nothing local and
# downloads the CLI from the registry on the target host -- a network install
# running unpinned code that no manifest or checksum covers. The zero-build
# entry points that ARE shipped must be the ones used.
# ---------------------------------------------------------------------------
printf '\nDatabase init is zero-build (no CLI fetch)\n'
# Strip comments before scanning. A comment that NAMES the forbidden command
# ("calling `npx prisma` here would resolve to nothing") is documentation, not
# an invocation, and matching it makes the assertion report a false defect --
# the same trap as scanning a script for forbidden words without removing its
# own comments.
init_db_body="$(awk '/^init_db\(\)/,/^}/' "$INSTALL_SH" | sed 's/[[:space:]]*#.*$//')"

if grep -q 'apply-migrations\.mjs' <<<"$init_db_body"; then
  ok "init_db uses the shipped apply-migrations.mjs"
else
  bad "init_db uses the shipped apply-migrations.mjs" \
      "the shipped migrator is not referenced in init_db"
fi

if grep -q 'create-admin\.mjs' <<<"$init_db_body"; then
  ok "init_db uses the shipped create-admin.mjs"
else
  bad "init_db uses the shipped create-admin.mjs" \
      "the shipped admin bootstrap is not referenced in init_db"
fi

# `npx prisma` is allowed ONLY on an explicit source-build branch, and only
# when a local prisma binary actually exists. What must never happen is the
# ZERO-BUILD branch (the .mjs files are present) silently falling through to it,
# because that is how a target host ends up fetching the CLI from a registry.
# So the assertion is about the branch structure, not about the mere presence of
# the string: `npx prisma` must appear AFTER a `command -v prisma` guard.
npx_line="$(grep -n 'npx prisma' <<<"$init_db_body" | head -1 | cut -d: -f1)"
guard_line="$(grep -n 'command -v prisma' <<<"$init_db_body" | head -1 | cut -d: -f1)"
if [[ -n "$npx_line" && -n "$guard_line" && "$guard_line" -lt "$npx_line" ]]; then
  ok "npx prisma only appears after a prisma-exists guard"
else
  bad "npx prisma only appears after a prisma-exists guard" \
      "npx at line ${npx_line:-none}, guard at line ${guard_line:-none}; the CLI could be fetched from a registry"
fi

if grep -q 'command -v prisma' <<<"$init_db_body"; then
  ok "any prisma CLI use is guarded by an existence check"
else
  bad "any prisma CLI use is guarded by an existence check" \
      "prisma is invoked without verifying a local binary exists"
fi

# The migrator is run with an explicit migrations directory. The shipped SQL
# lives at packages/db/prisma/migrations/<name>/migration.sql, one level deeper
# than the directory itself, so the path must be passed rather than left to the
# tool's cwd-relative default.
if grep -q -- '--migrations' <<<"$init_db_body"; then
  ok "init_db passes an explicit --migrations directory"
else
  bad "init_db passes an explicit --migrations directory" \
      "the migrator would fall back to a cwd-relative default"
fi

# The admin password must reach the tool as a flag or env var, never interpolated
# into a shell command string.
if grep -qE -- '--password "?\$admin_pass' <<<"$init_db_body"; then
  ok "the admin password is passed as a quoted flag, not spliced into a command"
else
  bad "the admin password is passed as a quoted flag, not spliced into a command" \
      "no '--password \"\$admin_pass\"' form found"
fi

# ---------------------------------------------------------------------------
# Tunnel binary supply chain: a pinned digest is useless if the version floats.
#
# A digest identifies ONE specific release asset. If the tag is resolved from
# "latest" at run time while the digest stays pinned, every upstream release
# invalidates the digest and the install refuses forever -- secure, and
# impossible to use. Version and digest must travel together.
# ---------------------------------------------------------------------------
printf '\nTunnel binary digests are pinned AND their versions are\n'
bin_body="$(awk '/^install_binaries\(\)/,/^}/' "$INSTALL_SH" | sed 's/[[:space:]]*#.*$//')"
table="$(awk '/^declare -A BIN_SHA256=\(/,/^\)/' "$INSTALL_SH")"

pinned_count="$(grep -oE '\[[a-z0-9_]+\]="[0-9a-f]{64}"' <<<"$table" | wc -l)"
if [[ "$pinned_count" -ge 1 ]]; then
  ok "at least one tunnel binary digest is pinned ($pinned_count of 8)"
else
  bad "at least one tunnel binary digest is pinned" \
      "every digest slot is empty, so every download is refused and the default install dies"
fi

# A malformed digest is worse than an empty one: it looks pinned and never matches.
bad_digest="$(grep -oE '\[[a-z0-9_]+\]="[0-9a-f]*"' <<<"$table" \
  | grep -vE '="([0-9a-f]{64})?"$' || true)"
if [[ -z "$bad_digest" ]]; then
  ok "every non-empty digest is a full 64-hex SHA-256"
else
  bad "every non-empty digest is a full 64-hex SHA-256" "$bad_digest"
fi

# For each pinned binary, the PINNED arm must not resolve a floating version.
# Scope to the arm itself: a fixed -A window spans both arms of the case, and
# `latest_release` legitimately lives in the UNPINNED arm. Read up to the next
# `esac` so only the `*)` arm is inspected.
for b in backhaul frp gost; do
  # Match the case header with index(), not a regex: the pattern contains `[`
  # and `${`, which awk would read as a bracket expression or a field reference.
  # The `*)` line ITSELF is printed (no `next`): in this code that line carries
  # the version assignment, so skipping it would exclude the exact thing under
  # test and make the assertion vacuously pass.
  pinned_arm="$(awk -v key="BIN_SHA256[${b}_" '
    index($0, "case \"") && index($0, key) && / in$/ {f=1; next}
    f && /^[[:space:]]*esac/ {exit}
    f && /^[[:space:]]*[*]\)/ {p=1}
    p {print}
  ' <<<"$bin_body")"
  if [[ -z "$pinned_arm" ]]; then
    bad "$b: a pinned-digest branch exists" "no '*)' arm found in the case statement"
  elif grep -q 'latest_release' <<<"$pinned_arm"; then
    bad "$b: the pinned-digest branch does not resolve a floating version" \
        "latest_release is reachable when a digest is pinned"
  else
    ok "$b: the pinned-digest branch does not resolve a floating version"
  fi
  # And the pinned arm must actually name the version the digest came from.
  if grep -qE 'v[0-9]+\.[0-9]+' <<<"$pinned_arm"; then
    ok "$b: the pinned-digest branch names a concrete version"
  else
    bad "$b: the pinned-digest branch names a concrete version" \
        "the pinned arm does not pin a tag"
  fi
done

# Verification must precede extraction, not follow it.
fetch_body="$(awk '/^fetch_and_extract\(\)/,/^}/' "$INSTALL_SH" | sed 's/[[:space:]]*#.*$//')"
v_line="$(grep -n 'sha256sum' <<<"$fetch_body" | head -1 | cut -d: -f1)"
x_line="$(grep -nE 'tar -xzf|unzip -q' <<<"$fetch_body" | head -1 | cut -d: -f1)"
if [[ -n "$v_line" && -n "$x_line" && "$v_line" -lt "$x_line" ]]; then
  ok "the checksum is verified BEFORE the archive is extracted"
else
  bad "the checksum is verified BEFORE the archive is extracted" \
      "verify at line ${v_line:-none}, extract at line ${x_line:-none}"
fi

# An unverified download must be refused by default.
if grep -q 'XT_ALLOW_UNVERIFIED_BIN' <<<"$fetch_body"; then
  ok "an unpinned download is gated on an explicit opt-in"
else
  bad "an unpinned download is gated on an explicit opt-in" \
      "no XT_ALLOW_UNVERIFIED_BIN gate in fetch_and_extract"
fi

# --- the documented rollback command must be a real, installed command ------
#
# Both READMEs tell operators to run `sudo xt-rollback /opt/xistance/releases/
# <prev>`, and the installer prints the same. That command is generated into
# /usr/local/bin by xt_install_rollback_command, so two things have to hold:
#
#   1. every user-facing instruction names the INSTALLED command, never a bare
#      shell function (xt_activate_release is sourced from lib/release-layout.sh
#      and is not on PATH -- on a real Ubuntu 22.04 host it was
#      "command not found", so the documented recovery path did not exist);
#   2. the wrapper restarts the unit. xt_activate_release only moves the
#      pointer and symlink, so a rollback that did not restart left the old
#      process serving the old code while health reported the new version.

printf '\n--- rollback command contract ---\n'

for doc in "$REPO_ROOT/README.md" "$REPO_ROOT/README_FA.md"; do
  if grep -qE '(^|[^_[:alnum:]])xt_activate_release' "$doc"; then
    bad "$doc does not instruct users to run a sourced shell function" \
        "found a bare xt_activate_release; use xt-rollback"
  else
    ok "$doc points users at the installed xt-rollback command"
  fi
done

if grep -q "xt-rollback" "$REPO_ROOT/README.md" && grep -q "xt-rollback" "$REPO_ROOT/README_FA.md"; then
  ok "both READMEs document the rollback command"
else
  bad "both READMEs document the rollback command" "xt-rollback missing from one of them"
fi

if grep -q "xt_install_rollback_command" "$RELEASE_INSTALL_SH"; then
  ok "release-install.sh installs the rollback command"
else
  bad "release-install.sh installs the rollback command" \
      "no xt_install_rollback_command call"
fi

# The call existing is not enough -- the function must be DEFINED before it is
# CALLED. It was previously defined ~15 lines after its call site, inside an
# unfinished `if` block, so a real Ubuntu 22.04 install printed
#   "xt_install_rollback_command: command not found"
# and exited 0 having installed nothing, while reporting success. The grep above
# passed the whole time because it matched the call.
DEF_LINE=$(grep -n '^xt_install_rollback_command()' "$RELEASE_INSTALL_SH" | head -1 | cut -d: -f1)
CALL_LINE=$(grep -n 'if xt_install_rollback_command; then' "$RELEASE_INSTALL_SH" | head -1 | cut -d: -f1)
if [[ -z "$DEF_LINE" ]]; then
  bad "xt_install_rollback_command is defined before it is called" \
      "no top-level definition of xt_install_rollback_command() found"
elif [[ -z "$CALL_LINE" ]]; then
  bad "xt_install_rollback_command is defined before it is called" \
      "the function is defined but never invoked by the installer"
elif [[ "$DEF_LINE" -lt "$CALL_LINE" ]]; then
  ok "xt_install_rollback_command is defined (line $DEF_LINE) before it is called (line $CALL_LINE)"
else
  bad "xt_install_rollback_command is defined before it is called" \
      "defined at line $DEF_LINE but called at line $CALL_LINE; bash would print \
'command not found' and the rollback helper would never be installed"
fi

# Defining it before calling it is not enough -- the wrapper also has to point at
# a file that actually EXISTS. It referenced "$WORK_DIR/lib/release-layout.sh"
# while the installer stages the library at "$WORK_DIR/release-layout.sh", so
# [[ -r ]] failed, the function returned 1, and the helper was never installed
# while the installer still exited 0 and printed a hint naming a missing command.
#
# Checked BEHAVIOURALLY, not by grepping: extract the function, give it a fake
# WORK_DIR laid out the way the installer actually lays it out, and require it to
# produce a wrapper. A grep for the path string passes on a file that merely
# mentions both paths -- the defect is which one is *used*.
EXTRACTED="$(mktemp /tmp/xt-rollback-fn.XXXXXX)"
awk '/^xt_install_rollback_command\(\)/{f=1} f{print} f&&/^}$/{exit}' "$RELEASE_INSTALL_SH" > "$EXTRACTED"
if [[ ! -s "$EXTRACTED" ]]; then
  bad "the rollback wrapper resolves release-layout.sh where the installer stages it" \
      "could not extract xt_install_rollback_command() from release-install.sh"
else
  FAKE_WD="$(mktemp -d /tmp/xt-rollback-wd.XXXXXX)"
  # The command is installed OUTSIDE the installer temp dir in production
  # (/usr/local/bin), which is exactly why sourcing the temp dir is fatal. Keep
  # the test faithful: separate the install location from WORK_DIR.
  FAKE_BIN="$(mktemp -d /tmp/xt-rollback-bin.XXXXXX)"
  FAKE_TARGET="$FAKE_BIN/xt-rollback"
  # The installer's real layout: the library sits directly in WORK_DIR.
  cp -f -- "$REPO_ROOT/scripts/lib/release-layout.sh" "${FAKE_WD}/release-layout.sh"
  if WORK_DIR="$FAKE_WD" XT_ROLLBACK_COMMAND_PATH="$FAKE_TARGET" bash -c "
        $(cat "$EXTRACTED")
        xt_install_rollback_command
      " >/dev/null 2>&1 && [[ -s "$FAKE_TARGET" ]]; then
    ok "the rollback wrapper builds from \$WORK_DIR/release-layout.sh, where the installer stages it"
  else
    bad "the rollback wrapper resolves release-layout.sh where the installer stages it" \
        "with release-layout.sh present at \$WORK_DIR/release-layout.sh (the layout the installer creates), the wrapper produced no command; it is pointing at a path that does not exist"
  fi

  # And the command must still WORK after the installer finishes. WORK_DIR is a
  # mktemp -d that release-install.sh removes on exit, so a wrapper sourcing it
  # failed with "No such file or directory" on every real invocation (verified
  # on Ubuntu 22.04 amd64) -- it installed fine and then never ran. Simulate the
  # installer's exit and require the command to still source cleanly.
  if [[ -x "$FAKE_TARGET" ]]; then
    # Read the reference BEFORE deleting WORK_DIR, then delete it and require
    # the reference to still resolve. WORK_DIR is a mktemp -d that
    # release-install.sh removes on exit, so a wrapper sourcing it failed with
    # "No such file or directory" on every real invocation (Ubuntu 22.04 amd64):
    # it installed fine and then never ran.
    LIBREF=$(sed -n 's/^XT_ROLLBACK_LIB="\(.*\)"$/\1/p' "$FAKE_TARGET" | head -1)
    rm -rf -- "$FAKE_WD"
    if grep -q "$FAKE_WD" "$FAKE_TARGET"; then
      bad "the rollback command outlives the installer temp dir" \
          "the generated command still references $FAKE_WD, which the installer deletes on exit; every rollback would fail with 'No such file or directory'"
    fi
    if [[ -n "$LIBREF" && -r "$LIBREF" ]]; then
      ok "the rollback command sources a library that survives the installer temp dir ($LIBREF)"
    else
      bad "the rollback command sources a library that survives the installer temp dir" \
          "the generated command references ${LIBREF:-<no XT_ROLLBACK_LIB>}, which does not exist once the installer cleans up; every rollback would fail"
    fi
  fi
  rm -rf -- "$FAKE_WD" "$FAKE_BIN" "$EXTRACTED"
fi

# The documented password-reset command must name the database the installer
# ACTUALLY creates. It documented /var/lib/xistance/xistance.db while the
# installer writes ${DATA_DIR}/app.db, so following the docs verbatim failed with
#   "admin creation failed: no such table: User"
# and left a stray empty xistance.db behind (verified on Ubuntu 22.04 amd64). An
# operator who had lost the password had no working recovery path. Bind the docs
# to the installer's real value instead of restating it.
INSTALLER_DB_BASENAME=$(grep -oE 'MIGRATION_DB="\$\{DATA_DIR\}/[a-z.]+"' "$RELEASE_INSTALL_SH" | head -1 | sed 's/.*\///; s/"//')
if [[ -z "$INSTALLER_DB_BASENAME" ]]; then
  bad "the READMEs name the database file the installer actually creates" \
      "could not read MIGRATION_DB from release-install.sh"
else
  for doc in "$REPO_ROOT/README.md" "$REPO_ROOT/README_FA.md"; do
    if grep -qE '^\s*--database /var/lib/xistance/[a-z.]+' "$doc"; then
      if grep -qE -- "--database /var/lib/xistance/${INSTALLER_DB_BASENAME}\b" "$doc"; then
        ok "$(basename "$doc") points create-admin at the database the installer creates (${INSTALLER_DB_BASENAME})"
      else
        bad "$(basename "$doc") points create-admin at the database the installer creates" \
            "documented --database path is not /var/lib/xistance/${INSTALLER_DB_BASENAME}; the documented reset command would fail with 'no such table: User'"
      fi
    else
      bad "$(basename "$doc") points create-admin at the database the installer creates" \
          "no '--database /var/lib/xistance/...' line found; the reset command is undocumented"
    fi
  done
fi

if grep -qE "Roll back with: xt-rollback" "$RELEASE_INSTALL_SH"; then
  ok "the installer's own rollback hint names the installed command"
else
  bad "the installer's own rollback hint names the installed command" \
      "the success message still tells users to run the shell function"
fi

if grep -qE "systemctl[[:space:]]+restart" "$REPO_ROOT/scripts/lib/release-layout.sh"; then
  ok "the rollback wrapper restarts the service"
else
  bad "the rollback wrapper restarts the service" \
      "no systemctl restart; the old process would keep serving the old code"
fi

# --- --port is honoured by a release install -----------------------------------
# Reported from a real server: `--release --version v1.2.0 --port 8085` died with
# "Unknown option: --port", because bootstrap.sh's own header and the README both
# advertise --port for release installs while release-install.sh rejected it. The
# deeper defect was quieter still: even via XT_PORT, nothing ever WROTE the port
# to the env file -- the template hardcoded PORT=8080 and PANEL_PORT was only read
# back for the health check. So a release install could only ever listen on 8080.
if grep -qE '^\s+--port\)' "$RELEASE_INSTALL_SH"; then
  ok "release-install.sh accepts --port"
else
  bad "release-install.sh accepts --port" \
      "bootstrap.sh and the README document --port for release installs; rejecting it is a dead end"
fi

if grep -qE '^\s+--port=\*\)' "$RELEASE_INSTALL_SH"; then
  ok "release-install.sh accepts --port=N as well as --port N"
else
  bad "release-install.sh accepts --port=N as well as --port N" \
      "only the space-separated form is parsed, so --port=8085 still fails"
fi

if grep -qE '^PORT=\$\{PANEL_PORT\}$' "$RELEASE_INSTALL_SH"; then
  ok "the env file template writes the requested PORT instead of a hardcoded 8080"
else
  bad "the env file template writes the requested PORT instead of a hardcoded 8080" \
      "PORT=8080 in the template means --port is accepted and then silently ignored"
fi

# Validation must run AFTER die() is defined. Getting this wrong leaves the
# script running with the check skipped, because bash resolves the function at
# call time -- the guard below is a comment-only marker, so grep the real order.
die_line="$(grep -nE '^die\(\)' "$RELEASE_INSTALL_SH" | head -1 | cut -d: -f1)"
port_check_line="$(grep -nE '^if \[\[ ! "\$PANEL_PORT" =~' "$RELEASE_INSTALL_SH" | head -1 | cut -d: -f1)"
if [[ -n "$die_line" && -n "$port_check_line" && "$port_check_line" -gt "$die_line" ]]; then
  ok "the --port guard runs after die() is defined"
else
  bad "the --port guard runs after die() is defined" \
      "die at line ${die_line:-none}, guard at ${port_check_line:-none}: 'die: command not found' and no validation"
fi

if grep -qE 'Invalid --port' "$RELEASE_INSTALL_SH"; then
  ok "an out-of-range --port is refused instead of deployed"
else
  bad "an out-of-range --port is refused instead of deployed" \
      "no port validation; a typo would leave a half-configured host"
fi

# Behavioural proof, not just a grep. --dry-run exercises the parse+validate path
# without touching the host, so the bad values must actually be rejected.
port_sandbox="$(mktemp -d)"
trap 'rm -rf -- "$port_sandbox"' EXIT

if bash "$RELEASE_INSTALL_SH" --version v9.9.9 --port 99999 --dry-run \
     --install-dir "$port_sandbox/opt" --data-dir "$port_sandbox/data" \
     --etc-dir "$port_sandbox/etc" >/dev/null 2>&1; then
  bad "--port 99999 is rejected at runtime" \
      "the installer accepted a port outside 1-65535"
else
  ok "--port 99999 is rejected at runtime"
fi

if bash "$RELEASE_INSTALL_SH" --version v9.9.9 --port notanumber --dry-run \
     --install-dir "$port_sandbox/opt" --data-dir "$port_sandbox/data" \
     --etc-dir "$port_sandbox/etc" >/dev/null 2>&1; then
  bad "--port notanumber is rejected at runtime" \
      "a non-numeric port was accepted"
else
  ok "--port notanumber is rejected at runtime"
fi

if bash "$RELEASE_INSTALL_SH" --version v9.9.9 --port 8085 --dry-run \
     --install-dir "$port_sandbox/opt" --data-dir "$port_sandbox/data" \
     --etc-dir "$port_sandbox/etc" >/dev/null 2>&1; then
  ok "--port 8085 is accepted at runtime"
else
  bad "--port 8085 is accepted at runtime" \
      "a perfectly valid port was refused"
fi

# Non-vacuity: a value that IS a port must not be refused. Without this the
# three checks above could all be satisfied by a guard that rejects everything.
if bash "$RELEASE_INSTALL_SH" --version v9.9.9 --port 65535 --dry-run \
     --install-dir "$port_sandbox/opt" --data-dir "$port_sandbox/data" \
     --etc-dir "$port_sandbox/etc" >/dev/null 2>&1; then
  ok "NON-VACUITY: the boundary port 65535 is accepted, so the guard is not blanket-refusing"
else
  bad "NON-VACUITY: the boundary port 65535 is accepted, so the guard is not blanket-refusing" \
      "the guard rejects valid ports too; the earlier refusals prove nothing"
fi

printf '\n--- %d passed, %d failed ---\n\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
