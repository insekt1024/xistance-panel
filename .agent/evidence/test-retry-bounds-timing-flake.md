# A suite that passed on an idle machine — found by running all 50 together

`test-retry-bounds.ts` had been green in every previous gate run. Running the
full 50-suite set (with the two Linux suites running under WSL) surfaced one
failure in 50. It then reproduced **7 failures out of 8 runs** on demand.

## The flake

```
FAIL a retry is pending before stop
```

The assertion was:

```ts
await handle.start();
await new Promise((r) => setTimeout(r, 40));   // hope the child has failed by now
const pendingBefore = clock.liveTimers;
if (pendingBefore > 0) ok("a retry is genuinely pending before stop");
```

The test starts a **real child process**, waits 40ms, and asserts a retry timer
now exists. A retry is only scheduled after the child actually exits. 40ms is
plenty on an idle machine and not enough on a busy one.

Reproduced with 8 background CPU workers:

| | result |
|---|---|
| before, unloaded | 23/23 pass |
| before, under load | **1/8 pass** — 7 failures, same assertion |
| after, unloaded | 23/23 pass |
| after, under load | **8/8 pass** |

**The product was never broken.** Nothing in `ChildProcessHandle` was at fault;
the test was asserting a wall-clock guess about a subprocess exit. That is a
different defect from a product bug, and worth distinguishing explicitly: this
one is in the evidence, not the code.

## The fix

A `waitFor(predicate, what, timeoutMs)` helper that polls, and the wait that
exists to let something *happen* now waits for that thing:

```ts
const becamePending = await waitFor(() => clock.liveTimers > 0, "a retry to be scheduled");
```

with a bounded 5s deadline, so a genuine regression still **fails** rather than
hanging — a poll without a deadline is just a slower flake.

### It did not weaken the assertion

A poll can be made vacuous by replacing the predicate with a constant, so that
was tested:

| | result |
|---|---|
| restored source | 23/23 pass |
| **MUTANT:** `waitFor(() => true, …)` | **exit 1, `FAIL a retry is pending before stop`** |

Still killed by the same assertion. The change made the *wait* robust; it did not
make the *check* optional. The assertion still reads `clock.liveTimers` — only
the moment at which it reads it is now determined by the system rather than
guessed.

## Why the runner surfaced it at all

Two reasons, both about the runner rather than luck:

1. **The suite had never been run alongside 49 others.** The aggregate run
   creates the CPU and process contention the flake needs. A suite run alone,
   twice, on an idle box, passes — which is exactly what I did first, and it
   told me nothing.
2. **The runner's failure report was truncating the evidence.** It printed the
   last 14 lines, and the failing assertion was *above* them — the log showed
   `22 passed, 1 failed` with no indication of which. Chasing that cost several
   steps. The runner now prints any `FAIL` / `not ok` / `✗` line explicitly
   before the tail, so the failing assertion is always in the report.

## Note on the remaining sleeps

The suite still has 13 fixed `setTimeout` calls. They were left alone: the ones
inspected wait for a *bounded* outcome (a 150ms process that is expected to
finish inside 150ms) rather than for a scheduled event, and converting them
without evidence would be churn. The helper is there for the next one.
