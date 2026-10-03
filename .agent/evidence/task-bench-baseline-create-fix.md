# Benchmark harness: create and diagnostics steps were never measured

Date: 2026-09-28
Scope: `scripts/bench-baseline.ts`, `scripts/lib/workload-contract.ts`.

## Symptom

`scripts/bench-baseline.ts` reported:

```
  create-tunnel        n=  5 ok=  0 p50=0.0ms p95=0.0ms max=0.0ms
  tunnel-diagnostics   SKIPPED: no tunnel was created, so there is nothing to diagnose
```

So two of the workload's seven steps measured nothing, and the harness correctly
refused to publish the result. The baseline was not trustworthy.

## Four defects, found in order

**1. Fixture exceeded the create budget.** `POST /api/tunnels` is rate limited to 10
per 60s per user; the fixture wanted 8 and the workload spends 5, so seeding alone
would exhaust the window and the run would measure a 429. The limiter is a real
production control, so it is respected rather than bypassed: the fixture was reduced
to 5, and `bench-baseline.ts` now throws if the fixture cannot fit
(`TUNNEL_CREATE_LIMIT - TUNNEL_CREATE_WORKLOAD_STEPS`). The workload's create count
is read from the contract rather than hardcoded, so the two cannot drift.

**2. Fixed port collided.** A hardcoded `sourcePort: 18200` meant the second create
returned 409 "Port already in use", so only 1 of 5 requests measured anything and the
harness published a p50 from a single sample.

**3. Port arithmetic overflowed.** Building the port by string concatenation
(`"182" + token`) produced `182134` and `18218300` — six digits, past 65535 — so every
create returned 422 `Number must be less than or equal to 65535` on the exact field
under test. A comment written mid-debug claimed the widest port was "182399,
comfortably inside 65535"; that was arithmetically wrong (six digits), and the wrong
comment is worth recording because it is what made the bug look resolved.

The root cause was distributing one decision across two files: the contract owned the
prefix, the harness owned the suffix, and neither could see the resulting value. The
contract now takes the WHOLE port as `{{sourcePort}}`, and the harness validates it in
the same place it is chosen (`portFor()` throws if outside 1..65535). `renderTemplate`
converts an all-digit substitution back to a number because the schema is `z.number()`
and a template is not valid numeric syntax; that check must run AFTER substitution, or
it silently never fires.

**4. A fixed port was also the wrong idea twice.** Replaced by a run-specific base
(19000) plus a coarse wall-clock offset. Wall clock, not the monotonic clock: monotonic
time starts at process launch, so `nowMs() % n` is near-identical for two runs started
in the same second and would collide anyway. Deliberately not random — a random base
makes the benchmark irreproducible, and reproducibility is the point of a baseline. The
port is recorded in the result JSON (`workloadPortBase`) so a run stays auditable.

## Diagnostics for future failures

A failing request now reports the body it SENT alongside the response. Two rounds of
guessing the port cost real time; the harness should have shown the value immediately.

## Result

Three consecutive full runs, no collisions:

| Step | n | ok | p50 |
|---|---:|---:|---|
| health | 20 | 20 | 2.5ms |
| list-tunnels | 20 | 20 | 2.5ms |
| list-nodes | 10 | 10 | 2.3ms |
| metrics | 10 | 10 | 1.5ms |
| search | 10 | 10 | 2.7ms |
| create-tunnel | 5 | 5 | 26.5 / 28.1 / 29.6ms across runs |
| tunnel-diagnostics | 10 | 10 | 2.8ms |

`create-tunnel` and `tunnel-diagnostics` are measured for the first time. Startup:
first health response 4.6ms, first authenticated response 8.1ms. Install: migrate
58ms, admin 86ms.

## Note

`bash scripts/test-line-endings.sh` → 60 passed, 0 failed. The harness is a `.ts` file
edited on Windows, where `patch` re-emits CRLF even when `.gitattributes` says
`eol=lf`; the check is run after every edit for that reason.
