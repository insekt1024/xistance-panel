#!/usr/bin/env bash
# Shared backup / restore helpers (TASK-38).
#
# Contract:
#   - A backup is only trustworthy if it can be PROVEN restorable, so every
#     archive carries a manifest and a checksum, and both are verified before
#     anything is extracted.
#   - Extraction is refused for an archive containing an absolute path, a `..`
#     component, or a symlink/hardlink target that escapes the destination.
#     `tar -x` run as root will happily write outside the destination otherwise.
#   - Permissions and ownership recorded in the archive are preserved, because
#     the config directory holds a key file that must stay 0600.
#   - Nothing here is destructive: a failed verification leaves the filesystem
#     exactly as it was.
#
# Safe to source with `set -u` enabled: functions and defaults only.

# Directory holding backups.
#
# An UNSET default only. Assigning a fallback here would be wrong: a library
# sourced after a caller has already computed its own default would silently
# win the race, and update.sh's backups landed in /var/backups/xistance instead
# of the install root the rest of the release layout uses. Each caller sets the
# value it wants; this only fills in a name for a direct backup.sh invocation.
: "${XT_BACKUP_DIR:=}"

# File name of the per-archive manifest, written INSIDE the archive root.
XT_BACKUP_MANIFEST_NAME=".xistance-backup-manifest"

# Path patterns excluded from a backup. Documented rather than implicit: an
# operator reading a backup must be able to know what is not in it.
#   logs/          - transient, regenerated on boot, can be large
#   *.log          - same, at any depth
#   tmp/ cache/    - scratch space, no value in a restore
#   *.db-wal *.db-shm - superseded by the checkpointed main database file
XT_BACKUP_EXCLUDES_DEFAULT="logs *.log tmp cache *.db-wal *.db-shm"

# Convert a path for a NATIVE binary (node). On Linux this is a no-op; under
# MSYS/Git Bash on Windows it is the difference between node opening the file
# and node failing with a module-resolution error.
native_path() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$p" 2>/dev/null || printf '%s' "$p"
  else
    printf '%s' "$p"
  fi
}

# sha256 of a file, portable across the images this ships to.
xt_sha256() {
  local f="$1"
  # Test-only injection point. A suite must be able to make verification FAIL on
  # demand -- otherwise the "refuses a bad backup" path is never exercised, and a
  # restore script that always says "verified" looks identical to a correct one.
  # Production never sets this.
  if [[ -n "${XT_TEST_SHA256_CMD:-}" ]]; then
    "$XT_TEST_SHA256_CMD" "$f"
    return $?
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$f" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$f" | cut -d' ' -f1
  else
    # The release already requires node; use it rather than failing.
    node -e '
      const c=require("crypto"),f=require("fs");
      const h=c.createHash("sha256");
      h.update(fs.readFileSync(process.argv[1]));
      process.stdout.write(h.digest("hex"));
    ' "$f"
  fi
}

# Emit tar exclusion flags for the given patterns.
_xt_backup_exclude_flags() {
  local p
  for p in ${XT_BACKUP_EXCLUDES:-$XT_BACKUP_EXCLUDES_DEFAULT}; do
    printf -- '--exclude=%s ' "$p"
  done
}

# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------
# Written into the archive root before it is created, then included in the
# tarball. One line per file: "<sha256>  <relative-path>". A restore verifies
# every entry afterwards, so a silently truncated backup is detected instead of
# being reported as a success.
xt_backup_write_manifest() {
  local root="$1" out="$2"
  [[ -d "$root" ]] || return 1
  : > "$out"
  local rel abs
  # LC_ALL=C keeps the ordering stable so the same tree always yields the same
  # manifest, which makes two backups comparable.
  while IFS= read -r rel; do
    abs="$root/$rel"
    [[ -f "$abs" ]] || continue
    printf '%s  %s\n' "$(xt_sha256 "$abs")" "$rel" >> "$out"
  done < <(cd "$root" && find . -type f -not -name "$XT_BACKUP_MANIFEST_NAME" \
             -not -path "*/logs/*" -not -name "*.log" \
             -not -path "*/tmp/*" -not -path "*/cache/*" \
             -not -name "*.db-wal" -not -name "*.db-shm" | LC_ALL=C sort | sed 's|^\./||')
  [[ -s "$out" ]]
}

# ---------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------
# xt_backup_create <source-dir> <archive.tar.gz>
#
# Checkpoints SQLite first: without it a backup can capture a database whose
# committed rows are still only in the write-ahead log, and a restore of that
# archive loses the most recent writes.
xt_backup_create() {
  local root="$1" tarball="$2"
  [[ -d "$root" ]] || { printf 'no such directory: %s\n' "$root" >&2; return 1; }

  local db
  for db in "$root"/*.db "$root"/*.sqlite "$root"/*.sqlite3; do
    [[ -f "$db" ]] || continue
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
    elif command -v node >/dev/null 2>&1; then
      # No sqlite3 binary: checkpoint through node's built-in SQLite, which the
      # release runtime always has. The guarantee must not depend on an optional
      # tool being installed.
      #
      # A checkpoint only merges the log when no OTHER connection is reading it,
      # and reports that as `busy`. A running panel always has one open, so
      # TRUNCATE alone silently does nothing while still looking successful.
      # VACUUM INTO is the fallback: SQLite itself writes a fully merged copy
      # into a fresh file, and that copy replaces the original atomically. It
      # does not need an exclusive lock, so it works with the service running.
      node -e '
        const { DatabaseSync } = require("node:sqlite");
        const fs = require("node:fs");
        const src = process.argv[1];
        const out = src + ".xt-backup-merged";
        try {
          const d = new DatabaseSync(src);
          const r = d.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
          d.close();
          if (r && r.busy === 0 && r.log === 0) process.exit(0);
          const c = new DatabaseSync(src, { readOnly: true });
          c.close();
          fs.rmSync(out, { force: true });
          const v = new DatabaseSync(src);
          v.exec("VACUUM INTO " + JSON.stringify(out));
          v.close();
          fs.renameSync(out, src);
        } catch (e) {
          try { fs.rmSync(out, { force: true }); } catch {}
        }
      ' "$(native_path "$db")" >/dev/null 2>&1 || true
    fi
    break
  done

  local staging manifest
  staging="$(mktemp -d "${TMPDIR:-/tmp}/xt-backup.XXXXXX")" || return 1
  # The manifest is built from a copy so the source tree is never written to.
  cp -a "$root/." "$staging/" 2>/dev/null || { rm -rf -- "$staging"; return 1; }
  rm -rf -- "$staging/logs" "$staging/tmp" "$staging/cache" 2>/dev/null || true
  find "$staging" -type f \( -name '*.log' -o -name '*.db-wal' -o -name '*.db-shm' \) -delete 2>/dev/null || true

  manifest="$staging/$XT_BACKUP_MANIFEST_NAME"
  xt_backup_write_manifest "$staging" "$manifest" || true

  mkdir -p "$(dirname "$tarball")"
  # shellcheck disable=SC2046
  if ! tar -czf "$tarball" -C "$staging" $(_xt_backup_exclude_flags) . 2>/dev/null; then
    rm -rf -- "$staging" "$tarball"
    printf 'archive creation failed\n' >&2
    return 1
  fi
  rm -rf -- "$staging"

  [[ -s "$tarball" ]] || { rm -f -- "$tarball"; printf 'archive is empty\n' >&2; return 1; }

  # The checksum is what update.sh checks before it changes anything, so it is
  # written as a sidecar next to the archive.
  xt_sha256 "$tarball" > "${tarball}.sha256"
  printf '%s\n' "$tarball"
}

# ---------------------------------------------------------------------------
# Verify
# ---------------------------------------------------------------------------
# xt_backup_verify <archive.tar.gz>
#
# Checks, in order: the archive exists, the checksum sidecar matches, the
# archive is readable, and no entry can escape the destination. Prints a
# summary on success. This runs BEFORE any extraction.
xt_backup_verify() {
  local tarball="$1"
  local force="${2:-0}"

  [[ -f "$tarball" ]] || { printf 'backup archive not found: %s\n' "$tarball" >&2; return 1; }
  [[ -s "$tarball" ]] || { printf 'backup archive is empty: %s\n' "$tarball" >&2; return 1; }

  if [[ -f "${tarball}.sha256" && "$force" != "1" ]]; then
    local expected actual
    expected="$(cut -d' ' -f1 < "${tarball}.sha256" | tr -d '[:space:]')"
    actual="$(xt_sha256 "$tarball")"
    if [[ "$expected" != "$actual" ]]; then
      printf 'backup checksum mismatch: %s\n  expected %s\n  actual   %s\n' \
        "$tarball" "$expected" "$actual" >&2
      return 1
    fi
  elif [[ ! -f "${tarball}.sha256" && "$force" != "1" ]]; then
    printf 'no checksum sidecar for %s; integrity cannot be proven\n' "$tarball" >&2
    return 1
  fi

  tar -tzf "$tarball" >/dev/null 2>&1 || {
    printf 'backup archive is unreadable (corrupt?): %s\n' "$tarball" >&2
    return 1
  }

  # Path safety. An entry is rejected if it is absolute, contains a `..`
  # component, or is a link whose target escapes the destination. A symlink
  # pointing at /etc/shadow is the same traversal as a `..` path, and tar
  # restores the link before the file that follows it.
  local entry
  while IFS= read -r entry; do
    case "$entry" in
      /*)
        printf 'refusing absolute path in backup: %s\n' "$entry" >&2; return 1 ;;
      ..|../*|*/../*|*/..)
        printf 'refusing parent-directory traversal in backup: %s\n' "$entry" >&2; return 1 ;;
    esac
    # A hardlink or symlink whose target is absolute or climbs out.
    if [[ "$entry" == *" -> "* || "$entry" == *" link to "* ]]; then
      local target="${entry##* -> }"
      target="${target##* link to }"
      case "$target" in
        /*|../*|*/../*)
          printf 'refusing link escaping the destination: %s -> %s\n' "$entry" "$target" >&2
          return 1 ;;
      esac
    fi
  done < <(tar -tzvf "$tarball" 2>/dev/null | sed 's/^[^ ]* [^ ]* [^ ]* [^ ]* [^ ]* *//')

  # stderr, not stdout: callers capture this function's stdout when they are
  # taking a path (`tarball="$(xt_backup_create ...)"`), and a confirmation
  # message on stdout silently corrupts that capture. The report is a human
  # message, not data.
  printf 'Backup verified: %s\n' "$tarball" >&2
  return 0
}

# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------
# xt_backup_restore <archive.tar.gz> <destination-dir>
#
# Verifies first, then extracts with permissions and ownership preserved, then
# re-checks every file against the manifest. A destination is never partially
# left in an unknown state: extraction happens into a sibling temp directory and
# is moved into place only after the manifest check passes.
xt_backup_restore() {
  local tarball="$1" dest="$2"
  xt_backup_verify "$tarball" || return 1

  local parent stage
  parent="$(dirname "$dest")"
  mkdir -p "$parent"
  stage="$(mktemp -d "${parent}/.xt-restore.XXXXXX")" || return 1

  # -p preserves permissions; --same-owner is left to tar's default so a
  # non-root restore does not fail, while a root restore (the real case) keeps
  # the owner of the key file.
  if ! tar -xzf "$tarball" -C "$stage" -p 2>/dev/null; then
    rm -rf -- "$stage"
    printf 'extraction failed: %s\n' "$tarball" >&2
    return 1
  fi

  # Manifest verification: every recorded file must be present with the
  # recorded digest. This is what makes "restored successfully" mean something.
  local manifest="$stage/$XT_BACKUP_MANIFEST_NAME"
  if [[ -f "$manifest" ]]; then
    local line digest rel abs
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      digest="${line%%  *}"
      rel="${line#*  }"
      abs="$stage/$rel"
      if [[ ! -f "$abs" ]]; then
        rm -rf -- "$stage"
        printf 'restore verification failed: %s is missing from the archive\n' "$rel" >&2
        return 1
      fi
      if [[ "$(xt_sha256 "$abs")" != "$digest" ]]; then
        rm -rf -- "$stage"
        printf 'restore verification failed: %s does not match its recorded digest\n' "$rel" >&2
        return 1
      fi
    done < "$manifest"
  else
    # An archive with no manifest predates this contract. Restoring it is
    # allowed, but the absence is stated rather than passed off as verified.
    printf 'note: this archive has no manifest; contents could not be verified\n' >&2
  fi

  if [[ -e "$dest" ]]; then
    local old
    old="$(mktemp -d "${parent}/.xt-old.XXXXXX")"
    rmdir "$old"
    mv "$dest" "$old" || { rm -rf -- "$stage"; return 1; }
    mv "$stage" "$dest" || { mv "$old" "$dest"; rm -rf -- "$stage"; return 1; }
    rm -rf -- "$old"
  else
    mv "$stage" "$dest" || { rm -rf -- "$stage"; return 1; }
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Update / rollback gate
# ---------------------------------------------------------------------------
# xt_backup_require <archive>
#
# update.sh calls this before it changes the active release. Without it, a
# migration can run against an installation whose backup turns out to be
# unreadable only after the damage is done.
xt_backup_require() {
  local tarball="$1"
  if [[ -z "$tarball" || ! -f "$tarball" ]]; then
    printf 'a verified backup is required before changing the active release\n' >&2
    return 1
  fi
  xt_backup_verify "$tarball" || {
    printf 'the existing backup did not verify; refusing to change anything\n' >&2
    return 1
  }
  return 0
}
