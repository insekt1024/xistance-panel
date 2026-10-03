# The "blocked" that was not blocked

A companion to `task-61-lowram-cgroup-executed.md`. Both suites in this file had
been reported as blocked for the entire release with the same justification:
*"needs the target platform."* Both ran here, on real Linux, in about a minute.

## What was actually available

```
$ wsl --status          Default Distribution: Ubuntu
$ wsl -d Ubuntu -- cat /etc/os-release     PRETTY_NAME="Ubuntu 26.04 LTS"
$ uname -m                               x86_64
$ stat -fc %T /sys/fs/cgroup              cgroup2fs
$ wsl -d Ubuntu -u root -- id -u          0
$ wsl -d Ubuntu -- node -v                v22.22.1
```

The release artifact is Linux amd64, so its native Prisma engine loads. The
error on Windows was precise about it: *"needs query_engine-windows.dll.node,
but the staged artifact ships only: libquery_engine-debian… , libquery_engine-linux-musl…"* —
i.e. it needed **Linux**, not a VPS.

The distinction that caused three turns of wrong reporting: **a target *host* is
not a target *platform*.** TASK-62–65 need a disposable VPS with credentials and
systemd. TASK-61 and TASK-16 need Linux. Only the first is actually blocked.

---

## TASK-16 — `test-protected-routes.ts` on Linux

```
✅ Protected-route smoke: health, auth redirect, localized login, and every
   referenced asset served
exit=0
```

This is the suite that proves the staged payload *serves* `public/` and
`.next/static` (Next's standalone output excludes both) and that protected
routes really are protected — booted from the artifact, with per-run disposable
secrets and a temporary SQLite database, using the same `create-admin.mjs` the
installer uses.

### Two environment obstacles, and the honest cost of the workaround

1. **`node_modules` holds Windows-native esbuild.** `npx tsx` inside WSL fails
   with a `TransformError` deep in esbuild's binary resolution. The suite itself
   imports only Node builtins plus one local helper, so the obstacle is the
   *runner*, not the test.
2. **Node 22.22 on this distro throws `ERR_NO_TYPESCRIPT`** — type stripping is
   not compiled in. WSL also has **no network**, so installing a Linux esbuild
   fails on the proxy.

Resolution: transpile the two files **on Windows** (where a native esbuild
exists) to plain CJS, then run the JavaScript on Linux. The test logic is
unmodified — only the module format changed. The tradeoff is explicit: this
exercises a transpiled copy of the suite, not the exact bytes CI would run. For
this suite that is a low risk (it asserts HTTP behaviour of a running server,
and `type: import` annotations are erased, not transformed), but it is not the
same artifact CI runs, and the browser gate remains the authoritative
Linux-side check.

### Two scratch-discipline errors, both mine

- An `npx esbuild --outfile=<relative>` wrote into **the repository** rather than
  the temp directory. Removed immediately; the repo-side `linuxrun/` tree is
  gone. The files were copied to `$TMPDIR` first and the scratch deleted after.
- `wslpath` is absent in that shell, and the outer MSYS shell expanded `$W`
  inside single quotes, so a probe silently ran against `/dist/artifact`. Both
  were caught by the script's own output rather than by an error. Writing the
  script to a file and passing the path avoids the interpolation entirely.

---

## TASK-61 — `test-lowram-cgroup-gate.sh` on Linux

Full result in `task-61-lowram-cgroup-executed.md`. Summary:

| cap | exit | result | kernel evidence |
|---|---|---|---|
| 256 MiB | 0 | PASS | 80 MiB peak (31%), `oom_kill 0`, 10/12 periods throttled |
| 48 MiB | 1 | **FAIL** | `oom_kill 1` — the negative control |

Also required fixing a stale fixture: the gate's `POST /api/nodes` payload
predated `username` becoming required in `NodeConfigSchema` during the SSH
hardening, returning `422 {"error":"username: Required"}`. The schema was right;
the test was out of date.

And it now **warns** on reclaim pressure. A 48 MiB run first returned
`oom_kill 0` with `high 403` and 100% of the cap consumed — a PASS that hid a
real limit. AC2's literal wording ("without OOM") is satisfied while the process
is being ground down by allocation churn, so reclaim events are now surfaced
explicitly without failing the gate.

---

## What is still genuinely blocked

**TASK-62–65 only.** They require a disposable Ubuntu VPS: a real installer run,
systemd unit management, update/migration/rollback, and sustained tunnel load.
That is a host with a credential, not an interpreter already on the machine.

All target connection values are [REDACTED]. Nothing in this file substitutes
for those runs, and no claim here should be read as covering them.
