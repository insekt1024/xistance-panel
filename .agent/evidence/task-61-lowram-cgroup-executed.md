# TASK-61 — one-vCPU / low-RAM constraint, executed on real Linux

This task had been reported as blocked for the whole release, on the grounds
that it "needs the target platform." That was **wrong**, and the error is worth
recording because it was my own and it was plausible.

## The wrong conclusion

TASK-62–65 (real Ubuntu VPS) genuinely need a target host credential. TASK-61
does not. Its own script says so at the top of the file:

```
# Usage (inside WSL as root):
#   wsl -d Ubuntu -u root -- bash -s -- <artifactRoot> <serverDir> < this.sh
```

I had collapsed "needs a target *host*" into "needs a target *platform*". The
difference is the difference between a missing credential and a missing
interpreter, and only the first is actually blocked.

## What was actually available

```
$ wsl --status
Default Distribution: Ubuntu
$ wsl -d Ubuntu -- cat /etc/os-release
PRETTY_NAME="Ubuntu 26.04 LTS"     uname -m: x86_64
$ stat -fc %T /sys/fs/cgroup
cgroup2fs                            $ id -u   (as -u root) -> 0
$ node -v
v22.22.1
```

Root works, cgroup v2 is writable, Node 22 present, and the release artifact is
Linux amd64 — so its native engine loads. Nothing was missing.

## Run 1 exposed a stale fixture

The first real run passed every stage and failed on one assertion:

```
  GET  /api/health   -> 200
  GET  /api/tunnels  -> 200
  GET  /api/nodes    -> 200
  GET  /api/metrics  -> 200
  GET  /api/search   -> 200
  POST /api/nodes    -> 422      <-- expected 200/201
RESULT: FAIL (stopped=1 apiFailed=1)
```

The 422 body: `{"error":"username: Required"}`. Not SSRF, not a cap problem —
the gate's fixture payload was written before `NodeConfigSchema` gained a
required `username` during the SSH option-injection hardening. The test was
stale; the schema was correct. Fixed to send a valid node
(`host=203.0.113.5, username=lowram, port=22` — a documentation address, so the
write exercises the database path without depending on any real host).

## Run 2 — TASK-61 passes

```
=== 2. apply the constraint, then VERIFY it applied ===
readback memory.max = 268435456
readback cpu.max    = 100000 100000
constraint VERIFIED written
=== 3. enter the cgroup BEFORE spawning anything that matters ===
shell cgroup: 0::/xt-lowram
=== 5. start the panel (inherits the cgroup) ===
server cgroup: 0::/xt-lowram
membership VERIFIED: the cap applies to the server process
=== 6. readiness ===  ready=1 after ~1s (health 200)
=== 7. API ===  login 200, csrf 32 chars, 5x GET 200, POST /api/nodes 201
=== 8. what the kernel actually charged ===
memory.peak = 83705856 bytes (cap 268435456)   31% of the cap
oom 0   oom_kill 0
nr_throttled 10 / nr_periods 12            <-- real CPU throttling observed
=== 9. clean shutdown ===  stopped, no listener remains
RESULT: PASS
```

| AC | evidence |
|---|---|
| constrains CPU/memory, records the actual limits | 256 MiB + 1 vCPU written, **read back**, and membership asserted in `/proc/<pid>/cgroup` |
| startup, health, API ops, shutdown without OOM | ready in ~1s, 6/6 API calls correct, `oom_kill 0`, clean exit |
| repeatable, no permanent host change | child cgroup created and removed; `subtree_control` verified unchanged after |
| CI cannot provide it → manual gate with a blocker | provided locally instead; blocker discharged |

## The negative control, and what it exposed

A gate that only ever passes proves nothing, so the cap was halved:

```
cap=268435456 (256 MiB)  exit=0  RESULT: PASS   80 MiB charged, 31%
cap= 50331648  (48 MiB)   exit=1  RESULT: FAIL   oom_kill 1
```

**The gate detects a real OOM kill.** That is the non-vacuity proof.

But the first attempt at that control returned `oom_kill 0` with `high 403` and
100% of the cap used — **RESULT: PASS**. The kernel reclaims instead of killing,
so AC2's literal wording ("without OOM") is satisfied while the process is being
ground down by allocation churn. A passing run that hides a real limit is
exactly the failure mode worth guarding, so the gate now prints reclaim
pressure explicitly:

```
WARN : 403 reclaim events -- no OOM kill, but this cap is too tight to be comfortable
```

It **warns rather than fails**: surviving at 100% of a cap and being OOM-killed
are different facts, and merging them would weaken the assertion AC2 actually
makes.

## Honest scope

This is **Ubuntu 26.04 LTS on WSL2**, not the 22.04/24.04 amd64 VPS that
TASK-62–65 require. It is real Linux with a real cgroup v2 and a real OOM
killer, and it discharges TASK-61. It does **not** substitute for TASK-62–65,
which additionally need systemd, a real installer run, and a disposable VPS. The
distinction is the same one the evidence has kept all along: what ran, and where
it ran.
