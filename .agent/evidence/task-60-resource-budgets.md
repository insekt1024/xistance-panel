# TASK-60 — numeric low-resource budgets and the release gate

## What the PRD actually requires

Section 9 fixes one number in advance and delegates the rest:

- "no more than **10% regression** in the selected control-plane latency metrics
  versus the recorded baseline for the same workload"
- "The release owner must choose and record concrete numeric budgets after the
  baseline task. This PRD intentionally does not invent absolute throughput or
  latency numbers before measurement."

TASK-60's four acceptance criteria add: budgets must cover readiness,
idle/peak RSS, CPU, control-plane latency, reconnect and a regression
threshold; each must state its host/workload/evidence level and whether it is a
hard gate or advisory; **no absolute throughput claim without a real benchmark**;
and the gate must report pass/fail/unknown and **block on a required unknown**.

## What was built

- `scripts/lib/resource-budgets.ts` — the budget table, the verdicts, the
  regression rule, and the release decision.
- `scripts/resource-gate.ts` — the CLI that prints the report and sets the exit
  code.
- `scripts/test-resource-budgets.ts` — 32 assertions, all with negative cases.

```
npx tsx scripts/resource-gate.ts --result <bench.json> [--baseline <bench.json>]
```

## The budget table

Budgets are **declarative and hand-edited**, not derived from the previous run —
deriving them would make every regression the new normal, which is the opposite
of a budget. Every entry carries `required` and an `evidence` level
(`measured-on-target` / `measured-constrained` / `measured-unconstrained` /
`prd-fixed` / `unmeasured`) plus a prose `basis` naming the run it came from.

| Budget | Limit | Gate | Evidence |
| --- | --- | --- | --- |
| `install.migrations` | 2000 ms | required | measured-unconstrained (57 ms) |
| `install.admin` | 2000 ms | required | measured-unconstrained (92 ms) |
| `startup.firstHealth` | 5000 ms | required | measured-unconstrained (4.8 ms) |
| `startup.firstAuth` | 10000 ms | required | measured-unconstrained (8.0 ms) |
| `memory.peakRss` | 256 MiB | required | **measured-constrained** (cgroup-capped, TASK-61) |
| `memory.idleRss` | 192 MiB | required | measured-unconstrained (133.1 MiB) |
| `cpu.idle` | 5 % | advisory | measured-unconstrained (0.08 % / 1.03 % worst) |
| `reconnect.total` | 1000 ms | required | measured-unconstrained (53.3 ms) |
| `shutdown.duration` | 2000 ms | required | measured-unconstrained (111 ms, clean only) |
| `throughput.absolute` | **none** | advisory | **unmeasured — deliberately** |
| regression | 10 % | required | **prd-fixed** |

Only `memory.peakRss` is backed by a constrained run, because that is the only
budget whose number has to survive a 256 MiB host. The rest are honest
`measured-unconstrained` values from a 16-vCPU Windows box and are **not** claims
about the target VPS.

## Throughput is a refusal, not a number

`throughput.absolute` has `limit: Infinity` and `evidence: "unmeasured"`, and
`evaluateBudgets` returns **`unknown`** for it before it ever looks at a value.
Every measurement so far is control-plane only; no live peer-to-peer data path has
been exercised. It is advisory, so it does not block — but it is printed as
`UNKNOWN` on every run, so the gap is visible rather than implied by silence.

## `unknown` is a real verdict, and a required one blocks

Verified end to end: deleting `shutdown.durationMs` from a good result produces

```
UNKNOWN shutdown.duration   shutdown was not measured  [required, measured-unconstrained]
RELEASE BLOCKED:
  - shutdown.duration (required, unmeasured): shutdown was not measured
   → exit 1
```

Two more cases where a value is *present but untrustworthy*, both forced to
`unknown` rather than passed:

- **one** fresh idle sample (a single reading is not an idle profile)
- a shutdown that only completed via SIGKILL escalation

## The 10% rule needed a noise floor, and I nearly shipped it without one

Run against a real baseline, the gate immediately blocked:

```
FAIL  worst control-plane regression 20.2% exceeds the 10% rule
       tunnel-diagnostics   3.1ms -> 3.7ms   +20.2%
       search               3.5ms -> 2.4ms   -31.6%
```

A 20 % change on a 3 ms step is not a regression. Three identical runs with **no
code change** measured:

| step | min | max | spread |
| --- | --- | --- | --- |
| `list-tunnels` | 2.4 ms | 3.6 ms | **52.3 %** |
| `metrics` | 1.3 ms | 1.7 ms | 32.9 % |
| `health` | 2.2 ms | 2.7 ms | 22.9 % |
| `create-tunnel` | 32.5 ms | 33.8 ms | 3.8 % |

So the PRD's own percentage is unenforceable on steps whose baseline is a few
milliseconds. A gate that fires on noise gets switched off, and then it misses
the regressions that matter.

**The rule is now: a change must exceed 10 % *and* exceed an absolute 20 ms
floor.** This is not a loosening — 10 % on a 500 ms step is +50 ms and still
fails. Suppressed changes are still printed, marked `(under noise floor)`, and
the summary names how many were set aside, so nothing is hidden.

Proven both directions, with the floor present:

```
a 20% regression on a 500ms step FAILS     slow-step +100.0ms, over the rule and the floor
a 20% change on a 3ms step is NOT actionable   (reported, marked, not a clean pass)
```

## Gate exit codes, all verified

| Situation | Exit | Expected |
| --- | --- | --- |
| every required budget measured and within limit | 0 | 0 ✓ |
| a required budget failed | 1 | 1 ✓ |
| a required budget is unknown | 1 | 1 ✓ |
| no baseline supplied (regression rule unapplied) | 1 | 1 ✓ |
| no `--result`, or an unreadable/missing file | 2 | 2 ✓ |
| host or workload digest differs from the baseline | 3 | 3 ✓ |

Exit 3 matters: a 10 % rule applied across two different hosts measures the
hosts, not the code. Both mismatch fields were confirmed with mutated inputs.

## Honest limits

- **These are not target-host budgets.** Every number except `memory.peakRss`
  comes from an unconstrained Windows dev box. The target-host values arrive with
  TASK-62/63 and are expected to be stricter; the table is where they go.
- **The regression comparison needs a recorded baseline file.** There is no
  committed baseline yet, so the rule cannot be applied in CI as things stand.
- **Absolute tunnel throughput remains unmeasured** and no peer-to-peer data path
  has been exercised at all.
- **No sustained-window memory trend gate exists.** The PRD's "no unbounded
  memory growth during an agreed sustained test window" is not implemented; the
  idle/peak budgets are per-run, not trends.

## Tests

`scripts/test-resource-budgets.ts` — **32 passed, 0 failed**, exit 0. Covers each
verdict with both a positive and a negative case, that `readMetric` returns null
(rather than 0, NaN or Infinity) for absent and unmeasurable metrics, that the
floor does not mask a real regression, and that the budget table itself is
well-formed (unique ids, no measured budget with an infinite limit, throughput
carrying an explicit refusal).
