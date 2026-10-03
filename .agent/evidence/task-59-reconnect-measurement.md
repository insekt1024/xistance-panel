# Reconnect/recovery measurement (TASK-59)

Date: 2026-09-29
Scope: `scripts/bench-baseline.ts`, `scripts/lib/workload-contract.ts`.

## What was missing

The harness already reported `notMeasured: ["tunnel throughput", "bandwidth",
"reconnect behaviour"]`. Latency for the control plane was measured (7 steps, all
with real samples), but recovery was never measured at all — so the PRD's
"reconnect/recovery measurement" criterion had no implementation behind it, and
TASK-60 cannot set a recovery budget from nothing.

## What was added

A fourth workload phase, `reconnect`, declared in the workload contract alongside
`install`/`startup`/`control` so the three existing phases are untouched and
comparability of the old numbers is preserved by the contract digest.

Three steps, each a real HTTP request against the running panel:

| Step | Method | Path | What it measures |
|---|---|---|---|
| `inject-fault-stop` | POST | `/api/tunnels/{id}/actions` | the operator-visible stop that puts the tunnel into recovery |
| `status-after-fault` | GET | `/api/tunnels/{id}` | that the panel's own view reports the stop rather than masking it |
| `recover-start` | POST | `/api/tunnels/{id}/actions` | the start that returns the tunnel to service |

### Why the fault is injected, not mocked

`stop` then `start`, against a real tunnel created by the control phase. The
endpoints are the real ones (`actions/route.ts` persists `state`/`status` and
drives the engine), so what is timed is the panel's own recovery path.
`restart` is deliberately not used: it is one request doing both halves, so it
cannot separate "the stop was honoured" from "the start recovered" — and a
recovery budget has to be writable against each half.

## Verification (real runs, `TURBO_DISABLE=true npx tsx scripts/bench-baseline.ts`)

Exit code 0 on all three runs. Every step `okCount=1`, `statuses={"200":1}`:

| Run | stop | status | start |
|---|---|---|---|
| 1 | 31.2ms | 12.7ms | 17.5ms |
| 2 | 33.2ms | 14.2ms | 17.7ms |
| 3 | 22.1ms | 5.6ms | 18.4ms |

Phase total: 61.7ms across 3 requests. Variance is ordinary first-run warm-up,
not a fluke: all three runs exercised the same path and all returned 200.

## Honesty boundary (the important part)

`notMeasured` was rewritten rather than left stale:

```
"tunnel throughput",
"bandwidth",
"live transport re-establishment between real peers (only control-plane
 stop/status/start recovery is measured)"
```

What is measured is the panel's **control-plane** recovery. Re-establishing a live
transport between two real peers is a different measurement that needs real nodes
and a network path, and this harness has neither. `assertNoUnmeasuredClaims`
still guards the forbidden `throughput`/`mbps`/`bandwidth` fields.

## Regression risk handled

The workload digest changed (`f55df24ca71de319`), so runs recorded before this
change are correctly *not* comparable to runs after it. That is the contract's
designed behaviour, not a side effect.

## Defect found and fixed while doing this

`npm run typecheck` covers only `apps/web` and the three packages — **`scripts/` is
not typechecked at all**. A type error introduced in `bench-baseline.ts` therefore
passed the full gate and only surfaced when the script was run
(`errors: { "..." }` where the field is `Record<string, number>`).

A `tsconfig.scripts.json` was written to close the gap and **measured 321
pre-existing errors** across the existing scripts. Wiring that into `typecheck`
would break CI on unrelated code, so the config was removed and `typecheck` left
unchanged. This is a real gap worth its own task, not something to land silently
inside a feature change.

Note: the error message (`663,79` on an 80-char line) pointed at the closing `}`
because the missing value is a property value, not a brace problem — the diagnostic
looks like a brace error but is a type error in an object literal.
