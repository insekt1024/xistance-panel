# TASK-15 evidence — systemd unit and migration contract

**Status:** passed (local contract tests; no live systemd start has run)

## What changed

| File | Change |
| --- | --- |
| `scripts/lib/service-unit.sh` | **new.** Single renderer for the panel unit: sanitises, quotes, and hardens every value. |
| `scripts/release-install.sh` | Uses the library; surfaces `daemon-reload`/`enable` failure instead of `\|\| true`; creates the service account. |
| `scripts/install.sh` | Same; no longer swallows `systemctl enable` failure. |
| `scripts/xistance.service.template` | Demoted from a rendered `@PLACEHOLDER@` template to a documented reference copy. |
| `scripts/test-service-contract.sh` | **new.** 24 contract tests. |

## Security issues found and fixed

1. **Directive injection into the systemd unit.** Both installers interpolated
   `$ENV_FILE`, `$NODE_BIN`, the release path, and the node path **raw** into a
   heredoc. A newline in any of them starts a new directive, so a value like
   `<path>\nExecStart=/bin/sh -c '…'` replaces the service command outright.
   Now every value goes through `xt_unit_safe`, which **refuses** a newline or
   carriage return and strips other control characters.
2. **Argument splitting on spaces.** `ExecStart=/usr/bin/node /opt/xistance
   current/apps/web/server.js` splits into three arguments. `ExecStart` and
   `WorkingDirectory` and `EnvironmentFile` are now double-quoted, with
   backslash and quote escaped, because systemd honours C-style escapes inside
   double quotes.
3. **`User=root`.** The panel serves a web UI, executes downloaded tunnel
   binaries, and holds an encrypted key store; any code-execution bug in any of
   those was a full host compromise. Now `User=xistance`/`Group=xistance`, with
   the account created as a system, no-login user that owns **only** the data
   directory. Releases stay root-owned and `0755`, so the service can execute
   its own code but not replace it.
4. **Silent service failures.** `release-install.sh` had
   `systemctl daemon-reload 2>/dev/null || true`, and `install.sh` had
   `systemctl enable … || true`. A unit systemd rejected therefore reported a
   *successful install* while the service never started. Both now go through
   `xt_install_service`, which checks `systemctl` presence, the unit directory,
   the write, `daemon-reload`, and `enable`, and returns non-zero on any of
   them.
5. **Template drift.** Two installers each had their own inline copy of the
   unit. They now share one renderer, so a fix cannot apply to one and miss the
   other.

## Hardening added to the unit

`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem=full`, `ProtectHome`,
`ProtectKernelTunables`, `ProtectControlGroups`, `RestrictSUIDSGID`, and
journal output.

## Contract coverage

`scripts/test-service-contract.sh` — **24 passed, 0 failed**:

- newline injection into env file / release root / node bin / description
- injected `/bin/sh` never reaches `ExecStart`
- the directive count never grows
- a release path with a space is quoted in `WorkingDirectory` and `ExecStart`
- `${VAR}` is preserved literally, never expanded during generation
- the unit is not `User=root`, declares an explicit `User`, and carries
  hardening
- both installers invoke the staged applier, never the Prisma CLI, and never
  `npm ci`/`install`/`run build`
- neither installer swallows `systemctl` failures; both check systemd presence

Tests run against the **real library**, not a reimplementation — the previous
draft of this suite reimplemented the renderer in the test, which is how a
sanitiser bug would have passed unnoticed.

**Non-vacuous (verified by mutation):** reverting the library to `User=root`
with unquoted `WorkingDirectory`/`ExecStart` gives **21 passed, 3 failed**.

## Migration contract

Migrations run from the staged release via `apply-migrations.mjs`, using the
configured database URL, with a data backup taken beforehand (TASK-14). The
assertions here lock that in: both installers must reference the applier and
must not shell out to the Prisma CLI or a package manager.

## Recorded gaps

1. **No live systemd start.** `systemctl daemon-reload/enable/restart`, the
   service account, and file ownership are unverified on a real host. In
   particular, whether a tunnel binary needs root to bind its port is untested —
   if one does, `User=xistance` will break it and the account needs a specific
   capability instead.
2. **`install.sh` seeds as root elsewhere.** The unit is now unprivileged but
   other install-time steps may still assume root; not audited here.
3. **Env-file contents are not validated.** `EnvironmentFile` is a real file of
   `KEY=value` lines; a malformed line makes systemd refuse to start the unit.
4. **`ProtectSystem=full` may block writes** the panel needs outside
   `RuntimeDirectory` (e.g. tunnel logs). Not tested against real use.
5. The old `@PLACEHOLDER@` template placeholders are gone, so any external
   tooling that rendered it must now call the library.

## Gates

`test-service-contract` 24/24; `test-update-flow` 24/24; `test-release-layout`
35/35; `test-release-cutover` 19/19; `test-release-installer` 23/23; `bash -n` on
all shell scripts; version:check, lint, typecheck clean; harness 77/77.
