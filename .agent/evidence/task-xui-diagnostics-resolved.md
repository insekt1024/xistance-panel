# XUI create-time diagnostics: resolved

Date: 2026-09-29

## What was reported earlier

`scripts/test-smoke-tunnel-diagnostics.ts` was recorded across three separate
runs as `60 passed, 1 failed`, with the same failure every time:

```
bad  a failed XUI sync records a summary at create time
```

That was carried forward as a recurring, unresolved product defect. **It is not
one.** The current suite passes in full.

## Current result

```
$ TURBO_DISABLE=true npx tsx scripts/test-smoke-tunnel-diagnostics.ts
...
  ok   a failed XUI sync records a summary at create time — state=error
       summary=unreachable: This operation was aborted
--- 69 passed, 0 failed ---
EXIT=0
```

The suite is 69 assertions (up from the 61 the stale logs showed), and the
previously failing assertion is the one that confirms the create-time
diagnostic carries a real summary.

## Why it reported failure before

Reading the suite, the fix is already present in the code, and its comment
records the exact defect that was corrected:

> Read the create-time diagnostic NOW. The M5 assertion further down
> deliberately starts this tunnel [...] and a successful action republishes
> `{status:"running"}` over the recorded failure. Reading the diagnostic after
> that point saw `state=running summary=""` and reported "the create route
> republished a success", when in fact the create route had reported correctly
> and the suite's own later action had overwritten the evidence.

So the original failure was a **test-ordering defect, not a product defect**:
the assertion read the diagnostic *after* the suite had deliberately restarted
the same tunnel, and the restart legitimately republished a success. The
capture was moved to immediately after create, before any action touches the
tunnel.

The `60 passed / 1 failed` results in the earlier notes predate that fix. The
exit code in those runs was already `0` — the harness reports counts and
exits successfully — which is itself the reason this needed re-running rather
than reading off a log: a suite that prints a failure but exits 0 cannot be
triaged from the exit status alone.

## The general lesson

A recurring failure in a suite that exits 0 on failure is not a reliable
signal, and neither is re-reporting a stale log across sessions. The two
independent signals — the per-assertion `ok`/`bad` lines and the counts — have
to be read from a run of the **current** code, and the assertion text itself
read, before a defect is claimed as open. This is the same class as the other
false-PASS defects found in this work: the instrument, not the product.

## Current suite status

| suite | result |
|---|---|
| `test-smoke-tunnel-diagnostics.ts` | **69 passed, 0 failed** |
| `test-optimizations.ts` | 77 passed, 0 failed |
| `test-origin-csrf.ts` | 69 passed, 0 failed |
| `mutate-origin-csrf.ts` | 9/9 mutants killed, 0 invalid |

No source change was needed for this item.
