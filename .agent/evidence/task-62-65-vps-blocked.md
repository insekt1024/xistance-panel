# TASK-62 / 63 / 64 / 65 — BLOCKED: no usable target host credentials

**Status: blocked, not waived and not passed.** These four gates require an
Ubuntu 22.04/24.04 amd64 host with root SSH access. This session has no
**credential** to any such host, and there is no way to satisfy them locally.
They are recorded here so the ledger is complete and the gap is explicit rather
than silent.

## Correction to the stated reason, 2026-09-30

An earlier version of this file said "no target host". That was imprecise, and
the imprecision matters because it points at the wrong remedy. Checked this
session:

- `TASK-1.json` records that a real VPS **was** supplied and independently
  verified on 2026-09-25 — Ubuntu 24.04.1 LTS, 1 vCPU, 961 MB RAM, amd64 — with
  a pinned host key fingerprint. The host address is deliberately not repeated
  here.
- A TCP probe of that host's SSH port **succeeds** (open).
- But the host is **absent from `~/.ssh/known_hosts`** (0 matches), and the only
  private key in `~/.ssh` belongs to an unrelated project.

So the blocker is not "there is no host" and not "the host is down" — it is that
**the access credential for that host is not present in this session.** Port
reachability is not access. I am not going to try to obtain access, and no
amount of local work closes this.

Two other things follow, and both are worth stating plainly:

1. **The recorded 2026-09-25 verification belongs to a previous session.** I can
   confirm the ledger entry exists and that the port still answers; I cannot
   confirm the host is the same machine, or still disposable, or still ours.
2. **A host supplied once is not a permanent capability.** If TASK-62…65 are
   still required, the access path needs to be re-supplied for this session.
   That is a request to the user, not something I can resolve.

## What is blocked, and why it cannot be simulated

| task | gate | why a local run does not answer it |
|---|---|---|
| TASK-62 | installer end to end on Ubuntu 22.04 | The installer is a bash script that installs a systemd unit, writes to `/etc/xistance`, runs `curl`/`tar` against a GitHub release, and switches a symlink. `scripts/test-release-installer.sh` is a **static** suite — 41 assertions that read the shell source. It proves the script contains the right invocations; it does not execute them. |
| TASK-63 | service startup, `/api/health`, static assets on Ubuntu 24.04 | Requires the systemd unit, real file ownership, and the Prisma query engine for the target platform. The local staged-artifact runs are `win32` and use a Windows query engine. |
| TASK-64 | update, migration, rollback on a live host | The atomic cutover (`current-release.txt` + `current` symlink replaced by rename) and the backup/restore cycle are only meaningful across two real releases on a real filesystem. |
| TASK-65 | tunnel load and reconnect on a live host | Requires two reachable servers, real SSH, and real tunnel binaries. Local suites exercise the engine against loopback fixtures. |

## What IS verified locally, and does not substitute

These are recorded so the blocked state is not mistaken for "nothing was done":

- **TASK-62 partial:** installer suite 41/41 against the real sources, plus a
  non-vacuity proof — three mutants (delete the migration call, drop its
  `--database` argument, make the failure non-fatal) each killed by the
  assertion written to catch it. See `task-installer-suite-vacuous-assertions.md`.
- **TASK-61:** low-RAM cgroup simulation passed on a Linux host.
- **TASK-63 partial:** `artifact-assets` 23/23 against the staged payload;
  `smoke-tunnel-diagnostics` 69 assertions; the browser gate reports
  `artifactCovered: true` — 12 suites, 597 assertions, 0 skipped.
- **TASK-57/58/60:** benchmark harness, resource budgets, and the regression
  gate all pass, with the host comparability check (exit 3) refusing to compare
  across incomparable hosts.
- **Artifact staging** produces a self-contained payload with its manifest and
  checksums, and `verify-artifact` inspects it.

## Exactly what is needed to unblock

1. An Ubuntu 22.04 amd64 host with root SSH access (TASK-62).
2. An Ubuntu 24.04 amd64 host with root SSH access (TASK-63), or the same host
   upgraded between runs.
3. A second reachable server per tunnel method for TASK-65 — the node roles in
   the panel are Iran and foreign, so a genuine load/reconnect test needs both.
4. Outbound network access from the host to the GitHub release URL (the
   installer fetches the artifact and its `.sha256` sidecar).

No host IP, credential, key, or other connection material has been recorded
anywhere in this evidence tree, and none is needed to write the evidence files
once a host is available. Connection details are supplied at run time and are
never written to the repository, evidence files, or logs.

## Exact next action

Supply the host(s). The harnesses for all four tasks already exist; what is
missing is a target to run them against. This is the only thing standing between
the current state and a release decision — every other gate is green.
