# TASK-104 — every PRD success metric has an enforcing gate

**Status: verified. All 11 section-15 metrics map to a gate that actually runs.**

The ledger reports 73/73 tasks evidence-backed. That proves every *task file* has
supporting evidence. It does **not** prove every PRD *success metric* is checked —
a task can be evidenced by a document while the criterion it serves is enforced
nowhere. That gap is now closed by a gate.

## The mapping

| PRD §15 metric | enforcing suite | what makes it enforcement |
| --- | --- | --- |
| baseline commands pass | `run-all-tests.ts` | the aggregate is the baseline command |
| nine methods' full evidence | `test-method-matrix.ts` | per-method suite for all nine; writes a machine-readable matrix |
| 0 critical/high findings | `test-supply-chain.ts` | 55 assertions; fails on unresolved high/critical |
| 0 secret leaks | `test-secret-redaction.ts` | 52 assertions over evidence, logs and output |
| 0 required static-asset 404s | `test-artifact-assets.ts` | drives the staged payload; 23/23, plus a broken-tree control that fails 3 named assertions |
| 0 unprotected panel-shell responses | `test-protected-routes.ts` | every panel route refuses an unauthenticated request |
| all architecture artifacts verify | `test-real-archive-verify.ts` | the real verifier against BOTH real archives |
| ≤10% latency regression | `test-resource-budgets.ts` | percentage **plus an absolute noise floor** and a blocking exit |
| WCAG 2.2 AA evidence | `test-a11y-contrast.ts` | 72 assertions over real routes |
| EN/FA documentation consistent | `test-readme-fa-parity.ts` | 66 assertions comparing EN and FA operational content |
| install/readiness + rollback drills | `test-target-runs-shipped-payload.ts` | a target running the shipped payload, byte-compared |

Plus the structural half: all four workflow jobs defined, the arm64 cell on
`ubuntu-24.04-arm`, and the docker image multi-architecture (TASK-103).

`scripts/test-prd-success-metrics.ts` — 19/19, mutation-verified (removing
`platforms:` fires 1 failure; restored to 19/19).

## The 10% rule is genuinely enforceable, not decorative

The pitfalls index warns that "no more than 10% regression" applied to a small
sample permits losing everything, and that a percentage threshold needs an
absolute floor. `scripts/lib/resource-budgets.ts` implements exactly that:

```ts
export const REGRESSION = {
  maxPctIncrease: 10,          // the PRD's own product rule
  minAbsoluteChangeMs: …,     // below this, a change is noise
```

and `resource-gate.ts` exits non-zero when the report is `blocked`. So the KPI
is a gate with a floor, not a number in a document.

## A false failure I produced, and what it taught me

The first run of this suite reported two failures:

```
FAIL 0 required static-asset 404s in release smoke test
     scripts/test-artifact-assets.ts exists but is not registered in run-all-tests.ts
FAIL UI acceptance includes WCAG 2.2 AA evidence
     scripts/test-a11y-contrast.ts exists but is not registered in run-all-tests.ts
```

Both were **wrong**, and the suite was the defect. `test-artifact-assets.ts` runs
under the Linux payload shell gate and `test-a11y-contrast.ts` under the browser
gate. I had checked only the TypeScript aggregate.

The fix is the more useful version of the check: a gate is enforced if **some**
runner executes it, so the assertion now searches all three runners — the
aggregate, `run-browser-gate.ts`, and `test-release-payload-linux.sh`.

This is the same lesson as the earlier `grep | head` truncation and the two
"squashed" mutations: **before reporting a missing gate, confirm the search was
looking in the right place.** A gate that is wired into a different runner is
enforced, and reporting it as unenforced would have been a false alarm in a
release-readiness report — precisely the kind of claim that erodes trust in the
whole document.

## What this does and does not establish

**Establishes:** every PRD success metric is enforced by a gate that runs, and
the mapping is asserted rather than assumed.

**Does not establish:** that any of those gates has passed on a machine other
than this one. The arm64 native-install gate and the `ubuntu-24.04-arm` CI cell
remain unexecuted, and the metrics above inherit that limit where relevant.
