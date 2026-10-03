# No additional tunnel method is in scope for 1.2.0

## The requirement, verbatim

`.agent/prd/PRD.md`, section 4 (Non-Goals and Scope Boundaries), line 30:

> **No new tunnel method in 1.2.0 unless later justified by a benchmark, threat
> model, and independent test plan. The nine existing methods remain the release
> scope.**

Corroborated by section 10 (Security Requirements):

> No new external integration or method is accepted without a threat model and
> negative tests.

And section 3, goal 1, names the release scope explicitly:

> Make all nine existing methods demonstrably reliable: `BACKHAUL`, `FRP`,
> `GOST`, `SSH`, `PORT_FORWARD`, `DIRECT`, `REVERSE`, `XRAY`, and `XUI`.

## What this resolves

An earlier working summary of this effort carried an open item reading
"additional-tunnel-method requirement" with the method name truncated and
unrecoverable, and instructed that it be recovered from the authoritative PRD
rather than guessed. It has been recovered, and the answer is that **there is no
such requirement for 1.2.0.**

The "additional method" was never a missing task to implement. It was a
constraint: adding one requires a benchmark, a threat model, and an independent
test plan, none of which exist, and section 4 places it outside the release.

## What this means for the work

The nine existing methods are the whole scope. So the real remaining work is
**stability of those nine**, which is TASK-26 through TASK-35, and it is
unaffected by this finding.

## Consequences that are already reflected in the code

Two decisions made earlier in this effort are consistent with this and should be
read as consequences of it, not coincidences:

- **`throughput.absolute` is an explicit refusal, not a number.** A benchmark
  backing a tenth method cannot exist without a real representative tunnel
  benchmark, and none does. The budget reports `unknown` on every run.
- **No live peer-to-peer data path has been exercised at all.** Every
  measurement so far is control-plane only, which is exactly the evidence level
  the PRD requires before it would even consider a new method.

## A note on the version target

The standing goal names `1.2.0` as the release target, and the PRD's non-goal is
scoped to 1.2.0. `npm run version:check` currently passes at `1.1.2`. The
version bump is deliberately not made here: the PRD also gates publication on
the installer path being verified end to end, and TASK-62 through TASK-65 (the
real Ubuntu VPS runs) are still outstanding. Bumping the version before those
pass would publish a version whose own acceptance criteria are unmet.
