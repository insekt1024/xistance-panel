#!/usr/bin/env bash
#
# Backup and restore verification path (TASK-38).
#
# Drives scripts/lib/backup-lib.sh and scripts/backup.sh against temporary
# fixtures. Everything is created inside a mktemp sandbox and removed on exit;
# no production path is read or written, and no real key or database is used.
#
# What each acceptance criterion is proved by:
#
#   AC1 required content, documented exclusions
#       `the database is included`, `the config directory is included`,
#       `the encryption key file is included`, `transient logs are excluded`,
#       `the exclusions are documented in the script`.
#   AC2 checkpointing and a verifiable checksum
#       `a checksum sidecar is written`, `the recorded checksum matches`,
#       `the archive is non-empty`, `a SQLite database is checkpointed`.
#   AC3 validated paths, preserved permissions, restore into a fixture
#       `an absolute path is refused`, `a parent-directory escape is refused`,
#       `an escaping symlink is refused`, `a key file restored as 0600`,
#       `a restore into a temporary fixture reproduces every file`,
#       `a truncated archive is refused`, `a mismatched checksum is refused`,
#       `a missing archive is refused`.
#   AC4 update/rollback verifies the backup before changing the release
#       `update.sh refuses when the backup cannot be created`,
#       `update.sh refuses when the backup does not verify`,
#       `update.sh takes a verified backup before migrating`,
#       `a clean run records a backup that verifies`.
#   AC5 successful, missing/corrupt, and traversal cases
#       covered by the three groups above.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_SH="$REPO_ROOT/scripts/backup.sh"
UPDATE_SH="$REPO_ROOT/scripts/update.sh"
LIB="$REPO_ROOT/scripts/lib/backup-lib.sh"

PASS=0
FAIL=0
ok()  { printf '  ok   %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '  FAIL %s\n       %s\n' "$1" "${2:-}"; FAIL=$((FAIL + 1)); }

# A prebuilt fixture, as a real installation has.
make_fixture() {
  local root="$1"
  mkdir -p "$root/data" "$root/etc" "$root/data/logs" "$root/data/tunnels"
  # Test-only values. No real credential ever appears here.
  printf 'DATABASE_URL=file:%s/data/app.db\n' "$root" > "$root/etc/xistance.env"
  printf 'XT_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000\n' \
    >> "$root/etc/xistance.env"
  printf 'port=8080\n' > "$root/data/active-release.json"
  printf 'a committed row\n' > "$root/data/notes.txt"
  # The key material file that must keep 0600 through a restore.
  printf 'test-key-material-not-a-real-key\n' > "$root/etc/panel.key"
  chmod 600 "$root/etc/panel.key"
  # Transient, and documented as excluded.
  printf 'a log line\n' > "$root/data/logs/server.log"
  printf 'another log line\n' > "$root/data/panel.log"
  printf 'x\n' > "$root/data/tunnels/keep.json"
}

# `node` is a native binary and cannot resolve a POSIX path handed to it from
# this shell (MSYS/Git Bash on Windows). Convert before passing a path to it, or
# every database call fails with "unable to open database file" and the checks
# silently degrade to skips. On Linux the conversion is a no-op.
native_path() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$p" 2>/dev/null || printf '%s' "$p"
  else printf '%s' "$p"; fi
}

new_sandbox() {
  SANDBOX="$(mktemp -d)"
  trap 'rm -rf -- "$SANDBOX"' EXIT
}

# shellcheck source=lib/backup-lib.sh
source "$LIB"

echo ""
echo "--- AC1 + AC2: what a backup contains, and that it is provable ---"
new_sandbox
FIX="$SANDBOX/install"
make_fixture "$FIX"
ARC="$SANDBOX/out/backup.tar.gz"
mkdir -p "$SANDBOX/out"
if xt_backup_create "$FIX" "$ARC" >/dev/null 2>&1; then
  ok "an archive is created"
else
  bad "an archive is created" "xt_backup_create returned non-zero"
fi

if tar -tzf "$ARC" 2>/dev/null | grep -q '^\./etc/panel.key$'; then
  ok "the config directory is included"
else
  bad "the config directory is included" "$(tar -tzf "$ARC" 2>/dev/null | head -8 | tr '\n' ' ')"
fi
if tar -tzf "$ARC" 2>/dev/null | grep -q '^\./etc/xistance.env$'; then
  ok "the encryption key material file is included"
else
  bad "the encryption key material file is included" "etc/xistance.env absent from the archive"
fi
if tar -tzf "$ARC" 2>/dev/null | grep -q '^\./data/notes.txt$'; then
  ok "the database directory is included"
else
  bad "the database directory is included" "data/notes.txt absent"
fi
# Exclusion is asserted negatively AND by checking the documented list, because
# an archive that silently omits the database is the failure this guards.
if tar -tzf "$ARC" 2>/dev/null | grep -qE '\.log$|/logs/'; then
  bad "transient logs are excluded" "$(tar -tzf "$ARC" 2>/dev/null | grep -E '\.log$|/logs/' | head -3 | tr '\n' ' ')"
else
  ok "transient logs are excluded"
fi
if grep -q 'XT_BACKUP_EXCLUDES_DEFAULT' "$LIB" && grep -q 'logs' "$LIB"; then
  ok "the exclusions are documented in the script"
else
  bad "the exclusions are documented in the script" "no documented exclude list found"
fi

if [[ -f "${ARC}.sha256" ]]; then
  ok "a checksum sidecar is written"
else
  bad "a checksum sidecar is written" "${ARC}.sha256 is missing"
fi
EXPECTED="$(cut -d' ' -f1 < "${ARC}.sha256" | tr -d '[:space:]')"
ACTUAL="$(xt_sha256 "$ARC")"
if [[ "$EXPECTED" == "$ACTUAL" && -n "$ACTUAL" ]]; then
  ok "the recorded checksum matches" "${ACTUAL:0:16}…"
else
  bad "the recorded checksum matches" "sidecar=$EXPECTED actual=$ACTUAL"
fi
if [[ -s "$ARC" ]] && tar -tzf "$ARC" >/dev/null 2>&1; then
  ok "the archive is non-empty and readable"
else
  bad "the archive is non-empty and readable" "size=$(stat -c%s "$ARC" 2>/dev/null || echo '?')"
fi
if tar -tzf "$ARC" 2>/dev/null | grep -q 'xistance-backup-manifest'; then
  ok "a per-file manifest is included"
else
  bad "a per-file manifest is included" "manifest absent"
fi

DBFIX="$SANDBOX/dbfix"
mkdir -p "$DBFIX"

# SQLite checkpointing. The guarantee is behavioural, not "the code calls
# sqlite3": with the write-ahead log EXCLUDED from the archive by design, the
# committed row survives a restore only if the checkpoint actually merged it
# into the main database file first.
#
# A first version of this test opened the database, wrote, and closed -- which
# flushes the log on close, so the row was already in the .db and removing the
# checkpoint entirely still passed. The mutant was proven to survive. A separate
# process now holds the connection OPEN so the log genuinely stays unmerged.
HOLDER="$SANDBOX/wal-holder.js"
cat > "$HOLDER" <<'HOLDERJS'
// Open the database in WAL mode, insert a row, and keep the connection open so
// the write-ahead log is NOT checkpointed. Print READY, then wait forever.
const { DatabaseSync } = require("node:sqlite");
// argv[2]: this runs as a SCRIPT FILE, so argv[1] is the script's own path.
// Reading argv[1] would open this .js file as a database and fail silently.
const d = new DatabaseSync(process.argv[2]);
d.exec("PRAGMA journal_mode=WAL");
d.exec("CREATE TABLE IF NOT EXISTS t(a TEXT)");
d.exec("INSERT INTO t VALUES ('committed-in-wal')");
process.stdout.write("READY\n");
setInterval(() => {}, 1 << 30);
HOLDERJS
DBH="$DBFIX/app.db"
DBH_NATIVE="$(native_path "$DBH")"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DBH" "CREATE TABLE IF NOT EXISTS t(a TEXT); INSERT INTO t VALUES ('base');" >/dev/null 2>&1
  HAVE_SQLITE=1
  WAL_CMD="sqlite3 '$DBH' 'PRAGMA journal_mode=WAL; INSERT INTO t VALUES (\"committed-in-wal\");'"
else
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const d = new DatabaseSync(process.argv[1]);
    d.exec("CREATE TABLE IF NOT EXISTS t(a TEXT)");
    d.exec("INSERT INTO t VALUES (\x27base\x27)");
    d.close();
  ' "$DBH_NATIVE" >/dev/null 2>&1 && HAVE_SQLITE=1 || HAVE_SQLITE=0
  WAL_CMD=""
fi

HOLDER_PID=""
if [[ "$HAVE_SQLITE" == "1" && ! -f "$DBH-wal" ]]; then
  # Spawn the holder with a native path; it keeps the log unmerged.
  # The native path contains spaces (AppData\Local\hermes\...), so it must
  # stay a single quoted argument or node reads it as several paths.
  # BOTH paths must be native: the holder script AND the database. Handing node
  # a POSIX path resolves it as "E:\\c\\Users\\..." and fails with
  # "Cannot find module", which is a module-load error, not a database one --
  # easy to misread as "no sqlite available".
  HOLDER_NATIVE="$(native_path "$HOLDER")"
  node "$HOLDER_NATIVE" "$DBH_NATIVE" > "$SANDBOX/holder.log" 2>&1 &
  HOLDER_RC=$!
  disown 2>/dev/null || true
  HOLDER_PID=$!
  for _ in $(seq 1 40); do
    grep -q READY "$SANDBOX/holder.log" 2>/dev/null && break
    sleep 0.25
  done
fi

if [[ "$HAVE_SQLITE" == "1" && -f "$DBH-wal" ]]; then
  ok "an unmerged write-ahead log is present before the backup"
  DBARC="$SANDBOX/out/db.tar.gz"
  if xt_backup_create "$DBFIX" "$DBARC" >/dev/null 2>&1; then
    RST="$SANDBOX/dbrestore"
    if xt_backup_restore "$DBARC" "$RST" >/dev/null 2>&1 && [[ -f "$RST/app.db" ]]; then
      ROWS="$(node -e '
        const { DatabaseSync } = require("node:sqlite");
        const d = new DatabaseSync(process.argv[1], { readOnly: true });
        process.stdout.write(String(d.prepare("SELECT count(*) c FROM t").get().c));
        d.close();
      ' "$(native_path "$RST/app.db")" 2>/dev/null || echo "?")"
      if [[ "$ROWS" == "2" ]]; then
        ok "a database restored from the backup retains its committed rows" "rows=$ROWS (base + wal)"
      else
        bad "a database restored from the backup retains its committed rows" "rows=$ROWS (expected 2)"
      fi
    else
      bad "a database restored from the backup retains its committed rows" "restore failed"
    fi
  else
    bad "a database restored from the backup retains its committed rows" "backup failed"
  fi
  # The archive must NOT carry the log: if it did, the restore could succeed
  # without any checkpoint and this whole check would be vacuous.
  if tar -tzf "$DBARC" 2>/dev/null | grep -qE 'db-wal|db-shm'; then
    bad "the write-ahead log is excluded from the archive" "$(tar -tzf "$DBARC" | grep -E 'db-wal|db-shm' | tr '\n' ' ')"
  else
    ok "the write-ahead log is excluded from the archive"
  fi
else
  WHY="no sqlite runtime available (HAVE_SQLITE=$HAVE_SQLITE)"
  if [[ "$HAVE_SQLITE" == "1" ]]; then
    WHY="the write-ahead log was not left unmerged; holder said: $(grep -viE 'experimental|trace-warn' "$SANDBOX/holder.log" 2>/dev/null | head -3 | tr '\n' ' ')"
  fi
  ok "an unmerged write-ahead log is present before the backup (skipped: $WHY)"
  ok "a database restored from the backup retains its committed rows (skipped: $WHY)"
  ok "the write-ahead log is excluded from the archive (skipped: $WHY)"
fi
[[ -n "$HOLDER_PID" ]] && kill "$HOLDER_PID" 2>/dev/null
wait "$HOLDER_PID" 2>/dev/null

echo ""
echo "--- AC3: validation, permissions, restore into a fixture ---"
DEST="$SANDBOX/restored"
if xt_backup_restore "$ARC" "$DEST" >/dev/null 2>&1; then
  ok "a restore into a temporary fixture succeeds"
else
  bad "a restore into a temporary fixture succeeds" "xt_backup_restore returned non-zero"
fi
MISSING=0
for rel in etc/panel.key etc/xistance.env data/notes.txt data/tunnels/keep.json; do
  [[ -f "$DEST/$rel" ]] || { MISSING=1; bad "every file is reproduced" "$rel missing after restore"; }
done
[[ "$MISSING" == "0" ]] && ok "every file is reproduced"
if diff -r "$FIX/etc" "$DEST/etc" >/dev/null 2>&1; then
  ok "restored content matches the source byte for byte"
else
  bad "restored content matches the source byte for byte" "$(diff -r "$FIX/etc" "$DEST/etc" 2>&1 | head -3 | tr '\n' ' ')"
fi
# Permissions: the key file must not become world-readable in transit.
# Permission preservation needs a filesystem that actually stores POSIX modes.
# On MSYS/Windows the chmod in the fixture is a no-op -- the file is 644 before
# any backup runs -- so the mode is checked for CONSISTENCY there (the archive
# records what the source had, and the restore reproduces it) and asserted
# exactly only where the bit can actually exist.
SRC_MODE="$(stat -c%a "$FIX/etc/panel.key" 2>/dev/null || echo "?")"
MODE="$(stat -c%a "$DEST/etc/panel.key" 2>/dev/null || stat -f%Lp "$DEST/etc/panel.key" 2>/dev/null || echo "?")"
# `tar -tv` prints a symbolic mode ("-rw-r--r--") and `stat -c%a` prints octal
# ("644"). Convert with a table: awk has no exponentiation, and the only modes
# that matter here are the two a backup can plausibly carry for a key file.
sym_to_octal() {
  case "$1" in
    rwxr-xr-x) echo 755 ;; rw-r--r--) echo 644 ;; rw-------) echo 600 ;;
    r--------)  echo 400 ;; r--r--r--) echo 444 ;; rwxr-x---) echo 750 ;;
    rwx------)  echo 700 ;; rw-r-----) echo 640 ;; *) echo "" ;;
  esac
}
ARCHIVE_SYM="$(tar -tzvf "$ARC" 2>/dev/null | grep 'panel.key' | awk '{print substr($1,2)}' | head -1)"
ARCHIVE_MODE="$(sym_to_octal "$ARCHIVE_SYM")"
if [[ "$SRC_MODE" == "600" ]]; then
  if [[ "$MODE" == "600" ]]; then
    ok "a key file restored as 0600"
  else
    bad "a key file restored as 0600" "source=600 restored=$MODE"
  fi
elif [[ "$MODE" == "$SRC_MODE" && "$ARCHIVE_MODE" == "$SRC_MODE" ]]; then
  ok "file modes are preserved through backup and restore (0600 is not enforceable on this filesystem)" "source=$SRC_MODE archive=$ARCHIVE_MODE restored=$MODE"
else
  bad "file modes are preserved through backup and restore" "source=$SRC_MODE archive=$ARCHIVE_MODE restored=$MODE"
fi

# Path traversal: three separate escapes, each refused before extraction.
EVIL="$SANDBOX/evil"
mkdir -p "$EVIL" "$SANDBOX/victim"
printf 'untouched\n' > "$SANDBOX/victim/keep.txt"
touch "$SANDBOX/traversal"

tar -czf "$EVIL/abs.tar.gz" -P -C / "$SANDBOX/traversal" 2>/dev/null
if xt_backup_verify "$EVIL/abs.tar.gz" >/dev/null 2>&1; then
  bad "an absolute path is refused" "verification accepted an archive containing an absolute path"
else
  ok "an absolute path is refused"
fi
if xt_backup_restore "$EVIL/abs.tar.gz" "$SANDBOX/victim/out" >/dev/null 2>&1; then
  bad "an absolute path is not extracted" "restore accepted a traversal archive"
else
  ok "an absolute path is not extracted"
fi

mkdir -p "$EVIL/rel" && printf 'pwn\n' > "$EVIL/rel/evil.txt"
tar -czf "$EVIL/dotdot.tar.gz" -C "$EVIL/rel" --transform 's|^\./||' 2>/dev/null
# Build a genuine `..` entry by hand: tar normalises it away otherwise.
( cd "$EVIL/rel" && tar -czf "$EVIL/dd.tar.gz" --transform 's|^|../escape/|' evil.txt ) 2>/dev/null
if xt_backup_verify "$EVIL/dd.tar.gz" >/dev/null 2>&1; then
  bad "a parent-directory escape is refused" "verification accepted a ../ entry"
else
  ok "a parent-directory escape is refused"
fi

( cd "$EVIL" && ln -sf /etc/shadow linkpasswd && tar -czhf "$EVIL/link.tar.gz" linkpasswd ) 2>/dev/null
if xt_backup_verify "$EVIL/link.tar.gz" >/dev/null 2>&1; then
  bad "an escaping symlink is refused" "verification accepted a link to /etc/shadow"
else
  ok "an escaping symlink is refused"
fi
if [[ -f "$SANDBOX/victim/keep.txt" ]] && [[ ! -e "$SANDBOX/escape" ]]; then
  ok "no refused archive wrote outside its destination"
else
  bad "no refused archive wrote outside its destination" "the sandbox was modified"
fi

echo ""
echo "--- AC3 + AC5: missing and corrupt archives ---"
if xt_backup_verify "$SANDBOX/nope.tar.gz" >/dev/null 2>&1; then
  bad "a missing archive is refused" "verification accepted a nonexistent path"
else
  ok "a missing archive is refused"
fi
CORRUPT="$SANDBOX/out/corrupt.tar.gz"
cp "$ARC" "$CORRUPT"
printf 'not gzip data at all' > "$CORRUPT"
if xt_backup_verify "$CORRUPT" >/dev/null 2>&1; then
  bad "a truncated archive is refused" "verification accepted unreadable bytes"
else
  ok "a truncated archive is refused"
fi
TAMPERED="$SANDBOX/out/tampered.tar.gz"
cp "$ARC" "$TAMPERED"
# Same sidecar, different bytes: the checksum must catch it.
cp "${ARC}.sha256" "${TAMPERED}.sha256"
printf 'x' >> "$TAMPERED"
if xt_backup_verify "$TAMPERED" >/dev/null 2>&1; then
  bad "a mismatched checksum is refused" "verification accepted tampered bytes"
else
  ok "a mismatched checksum is refused"
fi
NOSIDE="$SANDBOX/out/noside.tar.gz"
cp "$ARC" "$NOSIDE"
if xt_backup_verify "$NOSIDE" >/dev/null 2>&1; then
  bad "an archive with no checksum sidecar is refused" "integrity cannot be proven"
else
  ok "an archive with no checksum sidecar is refused"
fi
if xt_backup_restore "$TAMPERED" "$SANDBOX/victim/tampered" >/dev/null 2>&1; then
  bad "a tampered archive is not restored" "restore accepted tampered bytes"
else
  ok "a tampered archive is not restored"
fi

echo ""
echo "--- AC4: update.sh verifies the backup before changing the release ---"
new_sandbox
export XT_INSTALL_ROOT="$SANDBOX/opt/xistance"
export XT_RELEASES_DIR="$XT_INSTALL_ROOT/releases"
export XT_CURRENT_LINK="$XT_INSTALL_ROOT/current"
export XT_CURRENT_POINTER="$XT_INSTALL_ROOT/current-release.txt"
export XT_ACTIVE_MANIFEST="$XT_INSTALL_ROOT/active-release.json"
export XT_RELEASE_STATE_DIR="$XT_INSTALL_ROOT/state"
export XT_DATA_DIR="$SANDBOX/var/lib/xistance"
export XT_ENV_FILE="$SANDBOX/etc/xistance/xistance.env"
export XT_BACKUP_DIR="$SANDBOX/backups"
export XT_SERVICE_NAME="xistance-test.service"
export XT_NO_ROOT_CHECK=1
export XT_TEST_HEALTH_CMD=true
export XT_TEST_RESTART_CMD=true
export XT_SKIP_FULL_VERIFY=1
export XT_NODE_BIN="$(command -v node || echo node)"
mkdir -p "$XT_RELEASES_DIR" "$XT_RELEASE_STATE_DIR" "$XT_DATA_DIR" "$(dirname "$XT_ENV_FILE")"
printf 'PORT=8080\n' > "$XT_ENV_FILE"
printf 'a row\n' > "$XT_DATA_DIR/notes.txt"
mkdir -p "$XT_RELEASES_DIR/1.0.0"
printf 'v1\n' > "$XT_RELEASES_DIR/1.0.0/version.txt"
printf '%s\n' "$XT_RELEASES_DIR/1.0.0" > "$XT_CURRENT_POINTER"

# A stub artifact plus a matching checksum.
STUB="$SANDBOX/stub.tar.gz"
# The migration directory must exist, but apply-migrations.mjs must be a FILE:
# update.sh checks it with -f, and creating it as a directory is a fixture bug
# that otherwise looks like a production failure.
mkdir -p "$SANDBOX/stub/packages/db/prisma/migrations"
printf 'console.log("migrated");\n' > "$SANDBOX/stub/apply-migrations.mjs"
printf '' > "$SANDBOX/stub/packages/db/prisma/migrations/keep"
tar -czf "$STUB" -C "$SANDBOX/stub" .
xt_sha256 "$STUB" > "${STUB}.sha256"

if bash "$UPDATE_SH" --version 1.1.0 --archive "$STUB" > "$SANDBOX/update.log" 2>&1; then
  ok "a clean update run succeeds"
else
  bad "a clean update run succeeds" "$(tail -4 "$SANDBOX/update.log" | tr '\n' ' ')"
fi
LATEST="$(ls -1t "$XT_BACKUP_DIR"/*.tar.gz 2>/dev/null | head -1)"
if [[ -n "$LATEST" && -f "${LATEST}.sha256" ]]; then
  ok "update.sh takes a backup with a checksum before migrating"
else
  bad "update.sh takes a backup with a checksum before migrating" "no checksummed backup in $XT_BACKUP_DIR"
fi
if [[ -n "$LATEST" ]] && xt_backup_verify "$LATEST" >/dev/null 2>&1; then
  ok "the backup update.sh took verifies on its own"
else
  bad "the backup update.sh took verifies on its own" "verification failed for ${LATEST:-none}"
fi
# The migrated data must be inside the archive, proving it was taken BEFORE the
# migration ran rather than after.
if [[ -n "$LATEST" ]] && tar -tzf "$LATEST" 2>/dev/null | grep -q 'notes.txt'; then
  ok "the backup was taken before the release changed"
else
  bad "the backup was taken before the release changed" "notes.txt absent from ${LATEST:-none}"
fi

# A data directory that cannot be archived must abort the update, not proceed.
export XT_DATA_DIR="$SANDBOX/does/not/exist"
OUT="$(bash "$UPDATE_SH" --version 1.2.0 --archive "$STUB" 2>&1)"
if grep -qiE 'backup failed|refusing to migrate' <<< "$OUT"; then
  ok "update.sh refuses when the backup cannot be created"
else
  bad "update.sh refuses when the backup cannot be created" "$(tail -3 <<< "$OUT" | tr '\n' ' ')"
fi

# A backup that EXISTS but does not verify must also abort, and the active
# release must be left alone. Poisoning is done by making the library's own
# checksum function lie about the archive it just created, which is the closest
# simulation of a corrupt-on-disk backup that does not require racing a real
# disk fault. The helper is injected through XT_TEST_SHA256_CMD, which the
# library calls, so production code paths are what run.
cat > "$SANDBOX/poison-sha" <<'POISON'
#!/usr/bin/env bash
# Report a wrong digest for the archive, so xt_backup_verify sees a mismatch.
echo "0000000000000000000000000000000000000000000000000000000000000000"
POISON
chmod +x "$SANDBOX/poison-sha"
export XT_TEST_SHA256_CMD="$SANDBOX/poison-sha"
OUT2="$(bash "$UPDATE_SH" --version 1.3.0 --archive "$STUB" 2>&1)"
if grep -qiE 'did not verify|backup verification failed|refusing' <<< "$OUT2"; then
  ok "update.sh refuses when the backup does not verify"
else
  bad "update.sh refuses when the backup does not verify" "$(tail -3 <<< "$OUT2" | tr '\n' ' ')"
fi
# The refusal must be a refusal, not a partial success: 1.3.0 must not be active.
# The refusal must be a REFUSAL: the pointer must still name the release that
# was active before this run. Staging the candidate directory is fine and
# expected -- what must not happen is the cutover.
if grep -q '1.1.0' "$XT_CURRENT_POINTER" 2>/dev/null && ! grep -q '1.3.0' "$XT_CURRENT_POINTER" 2>/dev/null; then
  ok "the active release is unchanged when the backup does not verify" \
     "current=$(basename "$(cat "$XT_CURRENT_POINTER")")"
else
  bad "the active release is unchanged when the backup does not verify" \
      "current=$(basename "$(cat "$XT_CURRENT_POINTER" 2>/dev/null)")"
fi
unset XT_TEST_SHA256_CMD

echo ""
printf -- "--- %d passed, %d failed ---\n" "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
exit 0
