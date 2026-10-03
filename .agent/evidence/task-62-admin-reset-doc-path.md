# The documented password-reset command was broken in both READMEs (TASK-62)

Date: 2026-09-30
Target: **Ubuntu 22.04.5 LTS, amd64, systemd PID 1** — privileged Docker container
from image `xt-target:22.04`. Exact-OS container evidence, not remote-VPS
evidence. All credential values are throwaway probe values, `[REDACTED]`.

---

## The defect

Both READMEs told operators that if they ever lost the admin password, they
should run:

```bash
sudo node /opt/xistance/current/create-admin.mjs \
  --database /var/lib/xistance/xistance.db \
  --email admin@xistance.local \
  --password 'YOUR_NEW_PASSWORD' --reset-password
```

The installer does not create `xistance.db`. It creates **`app.db`**:

```
scripts/release-install.sh:479   MIGRATION_DB="${DATA_DIR}/app.db"
scripts/release-install.sh:515   --database "file:${DATA_DIR}/app.db"
scripts/release-install.sh:546   DATABASE_URL=file:${DATA_DIR}/app.db
```

The path in the docs was never the path on disk.

## Reproduced verbatim on the target OS

```
$ node /opt/xistance/current/create-admin.mjs \
    --database /var/lib/xistance/xistance.db \
    --email admin@xistance.local \
    --password '[REDACTED]' --reset-password
admin creation failed: no such table: User
EXIT: 1

# and it left a stray 0-byte file behind:
-rw-r--r-- 1 xistance xistance 172032 /var/lib/xistance/app.db
-rw-r--r-- 1 root     root          0 /var/lib/xistance/xistance.db   <-- created by the failed run
```

Two failures in one: the command exits 1 **and** creates an empty `xistance.db`
that an operator could easily mistake for the real database on a later attempt.
This is the worst kind of documentation defect — the failure looks like a
permissions or corruption problem, so the natural next step is more `sudo`, more
retries, or a re-install, none of which help.

An operator who had genuinely lost the password had **no working recovery path**.

## The fix

Both `README.md` and `README_FA.md` now name `/var/lib/xistance/app.db`.

The assertion added to `scripts/test-release-installer.sh` does not restate the
path — it **binds the docs to the installer**:

```bash
INSTALLER_DB_BASENAME=$(grep -oE 'MIGRATION_DB="\$\{DATA_DIR\}/[a-z.]+"' "$RELEASE_INSTALL_SH" ...)
```

so if the installer's database name ever changes, the docs cannot silently drift
again. This is the same shape as the existing `xt-rollback` / `xt_activate_release`
binding, and the same reason: a doc that hardcodes a value the code owns will
drift the first time the code changes.

## Verification

Suite **50 → 52**, and the mutation reproducing the shipped defect is killed:

| mutation | result |
|---|---|
| both READMEs reverted to `xistance.db` | **killed** — 2 failures, one per document |

`README.md points create-admin at the database the installer creates (app.db)`
`README_FA.md points create-admin at the database the installer creates (app.db)`

## Scope note

The corrected command was **not** executed live: the approval prompt for the
container run timed out, and it was not retried. What is verified here is that
the documented path now equals the path the installer writes, and that the wrong
path fails on the real target. A live `create-admin.mjs --reset-password` run
against `app.db`, followed by a login with the new password, remains unexecuted.

## The broader pattern

This defect was found by *running* a documented operator command, not by testing
it. The suite had no coverage of the reset path at all, and the Persian parity
suite — which does check that both READMEs document the same commands — passed
cleanly, because both documents carried the **same** wrong path. Parity between
two documents proves they agree, not that either is right.
