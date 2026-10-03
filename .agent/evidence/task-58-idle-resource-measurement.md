# TASK-58 — startup, idle and peak resource measurement

## What was missing

`bench-baseline.ts` already measured startup latency and two RSS peaks. Against
TASK-58's acceptance criteria it was missing two of the four named signals:

- **idle** RSS/CPU — only memory *under load* was sampled, which answers "what
  is the worst moment", not "what does an idle panel occupy". The second is the
  number an operator sizes a small VPS from.
- **shutdown duration** — `stop()` existed but timed nothing.

CPU was not reported by `/api/metrics` at all, so "idle RSS/CPU" could not be
satisfied without extending the endpoint.

## The measurement trap, and why sampling is sparse

`/api/metrics` is **cached for 20s and rate-limited to 20 requests/60s per user**.
Both are asserted production controls (`test-health-telemetry.ts` requires the
cache), so they were not touched. This makes the obvious implementation wrong:

> poll every 200ms, 10 samples → "rss stable across 10 samples"

That is one cached object returned ten times. It is indistinguishable from a
genuinely flat idle curve, and the CPU rate computed from it is a silent `0%` —
the exact shape of a healthy idle reading. It also exhausts the rate limit and
kills the run with HTTP 429 partway through the control phase, which is what
happened on the first attempt.

Two controls were therefore built rather than assumed:

| Control | Setup | Required result |
| --- | --- | --- |
| Negative | 6 samples at 250ms vs a 20s cache | repeats **rejected and counted out**, not averaged in |
| Positive | 4 samples at 21s (> TTL) | 4 distinct samples accepted, exit 0 |

### Freshness is decided by payload identity, not by age

The first implementation accepted a sample when `cache.ageMs < ttl/2`. That is
backwards: `ageMs` is measured **when the response is served**, so a cold cache
reports ~0ms and a warm one ~20s — both true for the *same* underlying
computation. The age test therefore accepted any number of repeats and rejected
the first reading after a fresh compute.

The fix dedupes on `generatedAt`, which is stamped when the data is **computed**.
Two samples sharing a `generatedAt` are the same reading whatever their age
claims. A payload with no `generatedAt` is never assumed fresh.

## Why cumulative CPU counters, not a percentage

The endpoint reports cumulative microseconds (`userMicros`, `systemMicros`,
`totalMicros`) rather than a percentage. A percentage must be derived by
differencing two samples, but the summary is cached, so two samples inside the
TTL return identical counters and the derived rate is a structural zero.
Cumulative counters stay correct under caching: differenced over a window wider
than the TTL, they give a real rate.

The rate is computed **per consecutive pair** and the **worst pair is reported
alongside the mean** — an average that hides one busy stretch is not an idle
measurement.

## The counter was proven live, not just present

An idle Node process genuinely burns almost no CPU, so `cpu: 0.00%` proves
nothing on its own. A field hard-coded to zero would pass every presence check
and make every idle-CPU number fiction.

`test-health-telemetry.ts` now asserts this **differentially**: apply 60 real
requests, wait out the cache, and require the counter to have risen.

- Present and positive at boot: `total=905ms`
- Rises under load: `+250ms over 127ms wall`

**Non-vacuity proven by mutation.** Replacing `process.cpuUsage()` with a
constant `{ user: 0, system: 0 }`, rebuilding and restaging:

```
FAIL CPU counters are reported
FAIL the CPU counter rises under load
--- 27 passed, 2 failed ---   exit 1
```

Both assertions fail on the dead field and pass on the live one. The source was
restored and rebuilt afterwards (`grep -c process.cpuUsage()` → 1).

## Shutdown

`staged-app.ts` now records wall-clock exit duration using `process.hrtime.bigint()`
— `Date.now()` can step backwards under NTP and yield a negative duration, which
is indistinguishable from no measurement. It also reports `shutdownForced`:
`stop()` escalates to SIGKILL after a 5s grace, and a shutdown that only ever
completes because it was killed is a defect a duration figure alone would average
away. `forced` is reported as a flag, never folded into the time.

## Third criterion: no leaked process or listener across repeated runs

Covered in `test-artifact-assets.ts`, which drives the real staged server rather
than a mock. `stop()` resolving is not evidence of anything, so the two facts are
checked independently:

| Assertion | Method | Why that method |
| --- | --- | --- |
| shutdown time was measured | `handle.shutdownMs` | null would read as "not applicable" rather than "not measured" |
| the server shut down **cleanly** | `handle.shutdownForced === false` | see below |
| the server process is gone | `process.kill(pid, 0)` | signal 0 probes existence without sending anything |
| the same port can be re-bound | a fresh `startStagedApp` on that exact port | a failed connect proves nothing — a firewall or an exhausted backlog refuses connections with no listener present. Only a successful **bind** is a positive statement. |

### The mutation that found a hole in my own test

Removing the graceful `child.kill()` from `stop()` **survived at 22 passed, 0
failed.** The pid check still passed, because `stop()` escalates to SIGKILL after
a 5s grace — the fallback cleaned up after the mutation. "The process is gone" is
satisfied by a clean exit and by a killed one alike.

The only assertion that separates them is the forced-kill flag, which I had
introduced in `staged-app.ts` but had not asserted anywhere. With it added:

```
MUTANT  (graceful kill removed): FAIL the server shut down cleanly rather than being killed
                                 --- 22 passed, 1 failed ---   exit 1
RESTORED                          ok  exited on the graceful path
                                 --- 23 passed, 0 failed ---   exit 0
```

A clean shutdown is ~14ms against a 5s grace, so `forced: true` is never an
acceptable result here.

### A second problem the same mutation exposed

The first mutant run died with `EPERM ... xistance-artifact-assets-*` before
reaching any leak assertion. The scratch database directory was deleted inside
`finally`, while a still-running server held the file open — so a cleanup
exception became the verdict and the real fault was never reported. Teardown
cleanup is now best-effort, and its failure is printed as a warning *after* the
assertions. It is a useful signal (it usually means something is still holding
the file) but it is not the verdict.

## Measured result

Host: win32/x64, artifact `dist/artifact-local`, workload digest
`f55df24ca71de319`, 88 control requests.

| Signal | Value |
| --- | --- |
| install — migrate | 57 ms |
| install — admin bootstrap | 92 ms |
| startup — first health | 4.8 ms |
| startup — first authenticated | 8.0 ms |
| **idle — RSS** | **133.1 MiB** over 4 samples |
| **idle — CPU** | **0.08%** mean, **1.03%** worst pair |
| shutdown | 111.3 ms, `forced: false` |
| startup peak RSS | 130.5 MiB (7 samples) |
| steady-state peak RSS | 128.5 MiB (8 samples) |

Fixture seeding remains reported separately and is not folded into any phase.
`peakRssBytes` is the max of the two peaks, since a low-RAM host fails at
whichever is larger.

## A stale artifact nearly made this all fiction

The first successful run reported `cpu 0.00%` and the counter probe returned
`cpu: null`. The cause: `dist/artifact-local` was dated **three days before** the
build that added the field. The benchmark was measuring a stale tree.

This is recorded because it is a general hazard, not a one-off: `bench-baseline.ts`
resolves `dist/artifact-local` first and falls back to `dist/artifact`, and
neither is refreshed by `npm run build`. Staging is a separate step
(`stage-local-test-artifact.ts` for Windows, `stage:artifact` for the Linux
release payload). **A benchmark run does not prove anything until the artifact it
measured was staged after the code under test was built.**

Related: `dist/artifact` is the single-architecture Linux release payload and
exits 77 with a clear message when staged on Windows, so the local fixture and
the release payload are not interchangeable.

## Honest limits

- **Build-time vs runtime resource use is separated** by construction:
  migrations, admin bootstrap and fixture seeding are setup and are reported
  under `install`, never inside a phase. Their CPU/memory is not attributed per
  stage.
- **Peak CPU is not measured.** Only idle CPU is. A CPU peak under a burst is
  visible in the control phase's latency percentiles, not as a CPU figure.
- **Cross-run growth is not asserted as a TREND.** A single run cannot prove
  "no unbounded growth within the agreed window" -- that needs the same
  measurement repeated and compared, and no such comparison was wired up. What is
  covered is the per-run half: no leaked process and no leaked listener (above).
  A repeated-run comparison remains open work.
- Idle CPU of 0.08% is a **Windows** figure. The release target is Linux.

## Gates after this change

| Gate | Result |
| --- | --- |
| `version:check` | pass, 7 files at 1.1.2 |
| `typecheck` | pass |
| build | exit 0 |
| `test-artifact-assets.ts` | 23 passed, 0 failed |
| `test-health-telemetry.ts` | 29 passed, 0 failed |
| `test-origin-csrf.ts` | 69 passed, 0 failed |
| `test-optimizations.ts` | 77 passed, 0 failed |
| `test-smoke-tunnel-diagnostics.ts` | 69 passed, 0 failed |
| `test-release-installer.sh` | 39 passed, 0 failed |
| `mutate-origin-csrf.ts` | 9/9 killed, 0 invalid |
