# One-vCPU / low-RAM simulation (TASK-61)

Date: 2026-09-29
Scope: capability audit of the local environment, then a constrained run of the
**staged release artifact** under a real cgroup v2 limit.

## Step 1 — capability audit (the task's first requirement)

The task says: *"do not pretend a normal runner is constrained."* So the
available mechanisms were measured before anything was claimed.

| Mechanism | Status | Evidence |
|---|---|---|
| Docker CLI | 29.4.2 present, **daemon unavailable** | `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine` |
| GitHub Actions runner | `ubuntu-latest`, **no resource limits** | all 3 jobs are plain `runs-on:` |
| WSL2 `Ubuntu` (WSL2) | **available, cgroup v2 capable** | `/sys/fs/cgroup/cgroup.controllers` = `cpuset cpu io memory hugetlb pids rdma`; `subtree_control` = `cpuset cpu io memory pids`; systemd 259; Node v22.22.1 |

Chosen method: **a child cgroup under WSL2's cgroup v2 root**, created per run
and removed after. The host's own configuration is never modified — verified by
printing `subtree_control` before and after (`cpuset cpu io memory pids`, and on
one run `... hugetlb ...` from an earlier probe, i.e. the host set is untouched by
this test).

Note: cgroup v2 requires **root** in the distro. The default WSL user gets
`cgroup.subtree_control read-only` and `mkdir: Permission denied`, so the gate
runs as `wsl -d Ubuntu -u root`.

## Step 2 — proving the limit is ENFORCED (not merely set)

A limit that is written but not enforced produces a green run that proves
nothing, so enforcement was proven first:

```
memory.max = 134217728  (128 MiB)   # read back
allocate 400 MiB, touching every 4 KiB page
=> process Killed
memory.events: oom 1, oom_kill 1
memory.peak  = 134217728   (exactly the cap)
```

**The first version of this probe was vacuous and reported the opposite
conclusion.** It allocated with `bytearray(1024*1024)` in a loop and printed
`ALLOCATED 400MiB -> LIMIT NOT ENFORCED`, while `memory.peak` sat at exactly the
cap and `oom_kill` was 0. A fresh `bytearray` is calloc'd, so its pages are never
faulted in and the cgroup is never charged — the allocation "succeeded" because
nothing was ever resident. Touching every page fixed it. Same shape as proving a
WAL checkpoint by closing the connection: the operation completes and proves
nothing.

## Two false-PASS defects found in the gate itself

**1. The limit was never applied to the process under test.** The gate moved the
shell into the cgroup *after* spawning the server. The server is a child of that
shell, so it had already inherited `/init.scope` — the log printed
`server cgroup: 0::/init.scope` and then `RESULT: PASS`. The limits were
verified as written, but the constrained run was unconstrained. Fixed by moving
the shell in *before* any spawn and then asserting
`/proc/<server-pid>/cgroup` contains `xt-lowram`, failing the run if it does not.

**2. The negative control controlled nothing.** `XT_MEM_MAX=33554432 wsl ...
bash -s` did not propagate the variable into the script at all: a run intended to
use a 32 MiB cap executed against the 256 MiB default and reported PASS. Limits
are now **positional arguments**, which cannot be dropped that way.

Also fixed: timing used `date +%s%3N`, but under WSL `%N` is not zero-padded to 3
digits — it returns 9-digit nanoseconds, so `%s%3N` produced a 16-digit number
and reported migrations as `121252620ms` (thirty-four hours for a 1.2s job).
Replaced with bash's `$EPOCHREALTIME`; the same job now reports `114ms`.

## Results

Both directions, against `dist/artifact` (the staged, relocatable payload — see
caveat below).

### Positive control — 256 MiB cap, 1 vCPU: PASS

```
constraint VERIFIED written          memory.max = 268435456, cpu.max = 100000 100000
membership VERIFIED: the cap applies to the server process
apply-migrations rc=0 (114ms)
create-admin       rc=0 (138ms)
ready=1 after ~6s
login -> 200
GET /api/health              -> 200
GET /api/tunnels             -> 200
GET /api/nodes               -> 200
GET /api/metrics             -> 200
GET /api/search?q=tunnel     -> 200
POST /api/nodes              -> 201
oom_kill 0
server stopped = 1 ; no listener remains ; memory drains after exit
RESULT: PASS
```

Install-time work (migrations + admin bootstrap) is run **inside** the cap,
because that work happens on a real VPS too.

### What the panel actually costs — and why `memory.peak` must not be quoted as RAM

`memory.peak` at the 256 MiB cap read 90–101 MiB. **That is not the app's
memory requirement**, and quoting it as one would overstate the footprint by
roughly 2x. Splitting `memory.stat` into its two components at the end of a run:

| memory cap | `anon` (real app memory) | `file` (page cache) |
|---|---|---|
| 256 MiB | **57 MiB** | 119 MiB |
| 128 MiB | 52 MiB | 69 MiB |
| 64 MiB | 23 MiB | 36 MiB |
| 32 MiB | 1 MiB | 26 MiB |

The anonymous footprint — the actual heap — is **~57 MiB including Node's
baseline**. The remainder is page cache charged to the cgroup because the panel
was executed from `E:` via WSL's `/mnt/e` 9p/DrvFs mount; reading the standalone
tree off a 9p share is far more expensive in page cache than reading it from
native ext4, which is what a real VPS has. So this simulation's totals are an
upper bound inflated by a filesystem artefact of the test host, and a VPS would
be expected to sit materially lower.

### Negative control — 64 MiB cap: FAIL, but nondeterministically

The first 64 MiB run genuinely died and is the control that matters:

```
readback memory.max = 67108864     membership VERIFIED
ready=1 after ~6s
login -> 000 ; every API -> 000
bash: 2375 Killed   PORT=$PORT ... node server.js
memory.events: oom 1, oom_kill 1
RESULT: FAIL        GATE_EXIT=1
```

The kernel OOM-killed the panel; `000` is connection-refused after the process
died. But **repeating 64 MiB five more times produced `oom_kill 0` and PASS every
time.** 64 MiB sits in a reclaim-versus-kill boundary: `anon` there is ~23 MiB
(measured), which fits, and cgroup v2 reclaims clean anonymous pages before
killing, so the outcome depends on whether the reclaim succeeds under
contention. A boundary that only fails sometimes is not a usable gate argument.

Caps that fail **reliably**, 2/2 each, are the ones below the install-time floor:

| cap | outcome | where it fails |
|---|---|---|
| 16 MiB | exit 1 ×2 | `FAIL: admin bootstrap did not complete under the cap` |
| 20 MiB | exit 1 ×2 | install-time, before the server starts |
| 23 MiB | exit 1 ×2 | install-time, before the server starts |
| 32 MiB | PASS ×2, `oom_kill 0` | survives at the cap via reclaim |
| 64 MiB | 1 FAIL / 4 PASS | boundary — nondeterministic |
| 256 MiB | PASS, `anon` 57 MiB | comfortable |

So the reliable floor is between 23 and 32 MiB for *install plus serve*, and the
serving footprint is ~57 MiB `anon`. The earlier claim of a "floor between 64 and
256 MiB" was wrong: it was reading a page-cache-inflated peak.

A cap sweep is also a check on the harness, not only on the product: because the
stale-cgroup bug above produced an identical `183MiB` peak for four different
caps, a sweep that does not vary its result is itself the signal that an
instrument is stuck.

### A third false reading, found in my own instrument

The `anon`/`file` sweep above reported `peak=183MiB` for **all four** caps —
256, 128, 64 and 32 MiB. A peak that does not move when the ceiling moves by 8x
is not a measurement. Reading back the script that produced it: it does
`mkdir -p $CG` with no removal of a pre-existing `xt-bd`, and `memory.peak` is
*not* reset by writing `memory.max` — it is a per-cgroup high-water mark since
the cgroup was created. So every run after the first inherited the first run's
peak.

The primary gate is not affected: it does remove and recreate `xt-lowram` in
step 2 (including moving any resident process out first), which is why its
`memory.peak` values did track the cap. But the `anon`/`file` figures are
current-value reads of `memory.stat`, so those remain valid; the `peak` column
from that sweep is discarded rather than repaired, since re-running it needs
approval that is currently outstanding.

Recorded because the failure mode is generic: **a high-water-mark counter that
is never reset reports the maximum ever seen, not the current run's maximum**,
and it looks entirely like a plausible per-run number.

## Caveat that matters for any Linux test in this repo

The **raw `apps/web/.next/standalone` tree cannot run on Linux.** Prisma resolves
its query engine via `config.dirname = __dirname`, which in the bundled output
points at `apps/web/generated/client`, while the engine is shipped at
`packages/db/generated/client`; build-machine Windows paths are also baked in.
It fails with `libquery_engine-debian-openssl-3.0.x.so.node ... was not found`.

This is **by design, not a product bug**: `scripts/rewrite-build-paths.ts` rewrites
build-machine absolute paths to release-relative form during staging, and
`stage-release-assets.ts` copies the client and engine. `dist/artifact` is
verified relocatable (0 occurrences of `E:\codes\Projects`). Any Linux-side test
must target the **staged** artifact, never `.next/standalone`.

## What TASK-61 does and does not establish

Satisfied:
- constrains CPU/memory with a real, verified, enforced limit and records it
- startup, health, representative API operations (reads *and* a write) and
  shutdown complete without OOM, without an orphan listener, and with memory
  draining afterwards
- repeatable; the host's permanent cgroup configuration is untouched
- bidirectional: a too-small cap fails with a real OOM kill

Not established here:
- this is a **local WSL2 simulation**, not the production Ubuntu VPS. Real
  kernel, real cgroup enforcement, but not the target host. TASK-62 (real VPS
  install) and TASK-65 (real tunnel load) remain separate and unproven.
