# TASK-90 — the official installer, actually executed on both target OSes

**Status: real installer verified on Ubuntu 22.04.5 and 24.04.5 amd64.**
Previously the release archive had only ever been *extracted* on the targets. The
installer itself had never been run end to end, which is why a verifier defect
(TASK-89) survived a green suite.

## 1. Why the installer had never been run

`scripts/release-install.sh` is a **repository script, not an archive file**. It
is not staged at the release root, so there is no `./release-install.sh` inside
the tarball to invoke. Two earlier attempts failed for reasons that were
properties of the *invocation*, not the installer:

| Attempt | Command | Result | Real cause |
| --- | --- | --- | --- |
| 1 | `cd /tmp/rel && ./release-install.sh` | `No such file` | the installer is not in the archive |
| 2 | `--version 1.2.0` | `Invalid version '1.2.0'` | the installer requires the **`v`-prefixed** tag form |
| 3 | `--archive /tmp/rel.tar.gz` (no sidecar) | `checksum verification FAILED` | the installer copies `<artifact>.sha256` from **beside** the archive; I shipped only the `.tar.gz` |
| 4 | installer + `lib/` scripts not staged | `release-layout.sh not found` | the installer sources its helpers from `$WORK_DIR/lib` |

None of these were installer defects. Attempt 4 was the only one carrying a
real missing-input error, and it was caused by the harness, not the product.

## 2. The invocation that works

```bash
# 1. stage the installer and its sourced helpers, preserving the lib/ layout
docker exec "$T" mkdir -p /tmp/inst/lib
docker cp scripts/release-install.sh      "$T:/tmp/inst/release-install.sh"
docker cp scripts/lib/release-layout.sh   "$T:/tmp/inst/lib/release-layout.sh"
docker cp scripts/lib/service-unit.sh     "$T:/tmp/inst/lib/service-unit.sh"

# 2. ship the archive AND its checksum sidecar
docker cp dist/amd64/xistance-panel-v1.2.0-amd64.tar.gz      "$T:/tmp/$ARCH"
docker cp dist/amd64/xistance-panel-v1.2.0-amd64.tar.gz.sha256 "$T:/tmp/$ARCH.sha256"

# 3. run it, with the v-prefixed tag
docker exec "$T" bash -c "bash /tmp/inst/release-install.sh --archive /tmp/$ARCH --version v1.2.0"
```

Note on the `DRY_RUN` variable: the script's header prints a "(dry run)"
banner, but `DRY_RUN=0` is the default (`scripts/release-install.sh:28`), and
`--dry-run` is opt-in at line 85. The install below is a real one — it wrote to
`/opt/xistance`, created the systemd unit, and started the service.

## 3. Result — Ubuntu 22.04.5 amd64 (`xtinst`, systemd PID 1)

```
archive checksum                                    : OK
artifact verified against release-manifest.json     : OK
migrations                                          : applied
admin account                                       : ensured
systemd unit xistance.service                       : installed + enabled
health check on 127.0.0.1:8080                      : passed
INSTALL EXIT                                        : 0
```

## 4. Result — Ubuntu 24.04.5 amd64 (`xt24`, systemd PID 1)

Identical outcome, `INSTALL EXIT: 0`.

## 5. Post-install live verification, both targets

| Property | xtinst (22.04.5) | xt24 (24.04.5) |
| --- | --- | --- |
| PID 1 | systemd | systemd |
| `/opt/xistance/current` | the newly installed release | the newly installed release |
| `systemctl is-active xistance` | active | active |
| `systemctl is-enabled xistance` | enabled | enabled |
| `GET /api/health` | 200 | 200 |
| `GET /api/nodes` (unauthenticated) | 401 | 401 |
| `POST /api/auth/login` (unauthenticated) | 307 | 307 |
| `/var/lib/xistance/app.db` owner | `xistance` | `xistance` |
| database size | 172,032 bytes | 172,032 bytes |
| `resetStreak` (TASK-88 product fix) in running payload | present | present |

The database is owned by the unprivileged service user on both, which is the
TASK-33 write-path property holding on the real release payload.

## 6. What this does and does not prove

**Proves:** the release archive plus sidecar verifies, extracts, migrates, seeds
an admin, installs and enables a systemd unit, and serves the authenticated API
correctly on both required target OSes. The TASK-88 retry fix and the TASK-85
migration-applier fix are both present in the payload that is actually running.

**Does not prove:** anything about arm64. These are amd64 targets. See
`task-82-arm64-service-gate.md` for the emulated arm64 service proof, and note
that the **native arm64 installer has still never completed** — it exits 7 on
`Cannot open: Invalid argument` from GNU tar under QEMU binfmt, which is an
emulation-layer failure, not a product failure. The native `ubuntu-24.04-arm`
CI runner cell has likewise never executed.

## 7. Regression gate added

`scripts/test-real-archive-verify.ts` (TASK-89) now runs the installer's own
verification command against the real staged archive, and is registered in
`scripts/run-all-tests.ts`. It carries a negative control that builds a tree
with a forbidden top-level entry and requires the verifier to **reject** it, so
the gate cannot pass vacuously.

Result at time of writing: **3/3**, and the full aggregate is **61/61 in
699.7s**. typecheck 0 errors, lint 0 errors / 22 warnings, version 7/7.
