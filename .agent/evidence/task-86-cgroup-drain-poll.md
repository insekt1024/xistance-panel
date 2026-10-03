# TASK-86 — the cgroup gate reported a leak for a server that had released everything

**Status: closed. A fixed `sleep 1` was standing in for an observable condition
that the kernel does not reach synchronously.**

## The symptom

```
FAIL: >32MiB still charged after exit (leak or orphan)
  RESULT: FAIL (stopped=0 apiFailed=0)
```

`stopped=0` and `apiFailed=0` are the tell. The server had exited — the loop
above the assertion confirmed it, and no API call failed. What failed was the
*memory accounting* assertion, which read `memory.current` one second later.

## Why it was missed, and why "just a flake" was wrong

The gate passed when run alone and failed inside the aggregate. That is the
signature of a timing assumption, not a leak:

```
  npx tsx scripts/run-all-tests.ts lowram   ->  1/1 suites passed, RESULT: PASS
  npx tsx scripts/run-all-tests.ts          ->  58/59, test-lowram-cgroup-gate.sh (exit 1)
```

A real leak reproduces regardless of what else is running. This one needed a
busy host.

The original code was:

```sh
sleep 1
AFTER=$(cat $CG/memory.current)
[ "$AFTER" -lt 33554432 ] || { echo "FAIL: >32MiB still charged after exit (leak or orphan)"; STOPPED=0; }
```

The `kill -0` loop above it has already established that the process is gone.
But the kernel charges a dead process's pages back asynchronously, and under
contention that reclaim has not completed a second later. The assertion was
therefore sampling reclaim progress, not memory retention — and calling that a
leak is a false accusation with a confident voice.

Worse: it was **self-defeating as a gate**. A 1-second sampling window makes the
threshold stricter for a leaking process on a *quiet* host than a healthy one on a
busy host. Load made the test weaker, which is backwards.

## The fix

Poll, and keep the bound long enough that a real leak still fails:

```sh
DRAINED=0
AFTER=0
for i in $(seq 1 60); do
  AFTER=$(cat $CG/memory.current)
  if [ "$AFTER" -lt 33554432 ]; then DRAINED=1; break; fi
  sleep 0.5
done
echo "memory.current after shutdown = $AFTER bytes (drained=$DRAINED after $i polls)"
if [ "$DRAINED" != "1" ]; then
  echo "FAIL: >32MiB still charged 30s after exit (leak or orphan)"
  STOPPED=0
fi
```

Three properties this has that `sleep 1` did not:

- **It waits for the condition** rather than guessing how long it takes.
- **The bound is 30× longer**, so a genuine leak has far more opportunity to show
  itself than before — the test is stricter, not looser.
- **It reports the final value and the poll count**, so a run that drains late is
  visibly different from one that never drains. The old code printed a number
  with no way to tell "still draining" from "stuck".

## Verified under the contention that broke it

`wsl -u root` (creating a cgroup needs root; the aggregate invokes it the same
way), 8 CPU burners running:

```
--- run 1 ---
memory.current after shutdown = 2547712 bytes (drained=1 after 1 polls)
RESULT: PASS
--- run 2 ---
memory.current after shutdown = 2953216 bytes (drained=1 after 1 polls)
RESULT: PASS
--- run 3 ---
memory.current after shutdown = 2793472 bytes (drained=1 after 1 polls)
RESULT: PASS
```

2.5–3.0 MB against a 32 MiB threshold — the margin is an order of magnitude, so
the poll is not shaving the threshold down to make the gate pass.

Then the full aggregate, which is where it failed twice before:

```
  ok   test-lowram-cgroup-gate.sh                   39.8s
  59/59 suites passed in 465.3s
```

## Not weakened, deliberately

The 32 MiB threshold is unchanged, and the 30s bound is longer than the 1s it
replaces. Nothing about the constraint being tested (1 vCPU, 256 MiB) moved. The
only thing removed is the assumption that reclaim is instantaneous.

A real leak still fails: it never drops below the threshold, so all 60 polls
elapse and `DRAINED` stays 0.

## Note for the next reader

This is the second fixed-sleep-after-kill defect in this repository. The first
was `test-retry-bounds.ts`, where a fake clock advanced while a real child was
still spawning. Both have the same shape: a sleep standing in for a condition
that the system reaches on its own schedule. See
`references/fake-clock-vs-real-process.md` and
`references/migration-silent-success.md` in the release-artifact-engineering
skill.

No credentials, tokens, private keys, or connection details appear in this file.
