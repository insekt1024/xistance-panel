// Proves the resource gate's three verdicts are real, and that the 20ms noise
// floor hides small changes WITHOUT hiding a genuine regression.
//
// This is the test the gate itself needed. Three claims, each with a positive and
// a negative case:
//   1. budgets pass/fail/unknown as the numbers dictate
//   2. a REQUIRED unknown blocks the release (never a silent pass)
//   3. the noise floor suppresses a 20%-on-3ms change but still fails a
//      20%-on-500ms one -- the floor is a magnitude guard, not a loophole
import {
  BUDGETS,
  REGRESSION,
  buildGateReport,
  evaluateBudgets,
  evaluateRegression,
  readMetric,
} from "./lib/resource-budgets";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A result with every metric present and healthy. */
function healthy(): Record<string, unknown> {
  return {
    install: { migrationsMs: 50, adminBootstrapMs: 80 },
    startup: { firstHealthResponseMs: 5, firstAuthenticatedResponseMs: 8 },
    memory: { peakRssBytes: 130 * 2 ** 20 },
    idle: { rssBytes: 133 * 2 ** 20, cpuPercent: 0.1, samples: 4 },
    shutdown: { durationMs: 100, forced: false },
    phases: [
      { phase: "control", steps: [{ id: "list-tunnels", p50Ms: 3, count: 10 }] },
      { phase: "reconnect", steps: [{ id: "recover-start", p50Ms: 20, count: 1 }] },
    ],
  };
}
function withStep(p50: number, id = "list-tunnels"): Record<string, unknown> {
  const r = healthy();
  (r.phases as Array<{ steps: Array<{ id: string; p50Ms: number }> }>)[0]!.steps = [
    { id, p50Ms: p50, count: 10 },
  ];
  return r;
}

console.log("\n--- a healthy result passes every measured budget ---");
{
  const v = evaluateBudgets(healthy());
  const measured = v.filter((b) => b.evidence !== "unmeasured");
  ok("every measured budget passes", measured.every((b) => b.verdict === "pass"),
    measured.filter((b) => b.verdict !== "pass").map((b) => `${b.id}=${b.verdict}`).join(",") || "all pass");
  // Throughput must be unknown, never pass. A pass here would be the most
  // misleading line in the whole report.
  const tp = v.find((b) => b.id === "throughput.absolute");
  ok("throughput is unknown, not a pass", tp?.verdict === "unknown", `verdict=${tp?.verdict}`);
  ok("throughput being unknown does NOT block (it is advisory)", !tp?.required);
}

console.log("\n--- an over-limit budget fails ---");
{
  const r = healthy();
  (r.memory as { peakRssBytes: number }).peakRssBytes = 300 * 2 ** 20;
  const v = evaluateBudgets(r);
  const mem = v.find((b) => b.id === "memory.peakRss");
  ok("peak RSS over budget fails", mem?.verdict === "fail", mem?.detail);
  const report = buildGateReport(v, { verdict: "pass", detail: "", comparisons: [] });
  ok("a failed required budget blocks the release", report.release.blocked);
  ok("the blocking reason names the budget", report.release.reasons.some((x) => x.includes("memory.peakRss")));
}

console.log("\n--- a required budget that could not be measured is unknown AND blocks ---");
{
  const r = healthy();
  delete (r.idle as { rssBytes?: number }).rssBytes;
  const v = evaluateBudgets(r);
  const idle = v.find((b) => b.id === "memory.idleRss");
  ok("absent metric reads as unknown", idle?.verdict === "unknown", idle?.detail);
  const report = buildGateReport(v, { verdict: "pass", detail: "", comparisons: [] });
  ok("a required unknown blocks the release", report.release.blocked);
  ok("the reason says unmeasured, not merely failed",
    report.release.reasons.some((x) => x.includes("unmeasured")));
  ok("summary counts it under requiredUnknown", report.summary.requiredUnknown === 1,
    `requiredUnknown=${report.summary.requiredUnknown}`);
}

console.log("\n--- a metric present but not trustworthy is unknown, not a pass ---");
{
  const r = healthy();
  (r.idle as { samples: number }).samples = 1; // one reading is not an idle profile
  const v = evaluateBudgets(r);
  const idle = v.find((b) => b.id === "memory.idleRss");
  ok("a single idle sample is unknown", idle?.verdict === "unknown", idle?.detail);
}
{
  const r = healthy();
  (r.shutdown as { forced: boolean }).forced = true; // only exited via SIGKILL
  const v = evaluateBudgets(r);
  const sd = v.find((b) => b.id === "shutdown.duration");
  ok("a SIGKILL-escalated shutdown is not a pass", sd?.verdict === "unknown", sd?.detail);
}

console.log("\n--- readMetric never fabricates a number ---");
{
  ok("absent memory -> null", readMetric({}, "memory.peakRss") === null);
  ok("absent idle cpu -> null", readMetric({}, "cpu.idle") === null);
  ok("throughput is structurally null", readMetric(healthy(), "throughput.absolute") === null);
  ok("unknown id -> null", readMetric(healthy(), "no.such.budget") === null);
  // The dangerous case: a NaN or Infinity must not sail through as a value.
  const nan = healthy();
  (nan.memory as { peakRssBytes: number }).peakRssBytes = Number.NaN;
  ok("NaN memory -> null, not NaN", readMetric(nan, "memory.peakRss") === null);
}

console.log("\n--- the 10% rule still fails a REAL regression (the floor is not a loophole) ---");
{
  // 500ms baseline step, 20% slower = 100ms. Far above the 20ms floor.
  const base = withStep(500, "slow-step");
  const cand = withStep(600, "slow-step");
  const r = evaluateRegression(base, cand, REGRESSION);
  ok("a 20% regression on a 500ms step FAILS", r.verdict === "fail", r.detail);
  ok("the failing step is named", r.detail.includes("slow-step"), r.detail);
}
{
  // The exact case the floor exists for: 20% on a 3ms step.
  const r = evaluateRegression(withStep(3), withStep(3.6), REGRESSION);
  ok("a 20% change on a 3ms step is NOT actionable", r.verdict === "pass", r.detail);
  ok("it is still reported, not hidden",
    r.comparisons.some((c) => c.step === "list-tunnels" && (c.pct ?? 0) > 10));
  ok("and it is marked as under the floor, not as a clean pass",
    r.comparisons.every((c) => c.actionable === false));
}
{
  // A large IMPROVEMENT must not fail, and must not reset anything.
  const r = evaluateRegression(withStep(500, "s"), withStep(100, "s"), REGRESSION);
  ok("a large improvement passes", r.verdict === "pass", r.detail);
}
{
  // A step present in the BASELINE but missing from the candidate is the case
  // that matters -- that is a step that stopped being exercised, which would
  // silently shrink the gate's coverage. The loop iterates the baseline's steps
  // for exactly that reason.
  const base = withStep(5, "kept");
  (base.phases as Array<{ steps: unknown[] }>)[0]!.steps = [
    { id: "kept", p50Ms: 5, count: 10 },
    { id: "dropped", p50Ms: 7, count: 10 },
  ];
  const cand = withStep(5, "kept");
  const r = evaluateRegression(base, cand, REGRESSION);
  ok("a baseline step missing from the candidate is reported",
    r.comparisons.some((c) => c.step === "dropped" && Number.isNaN(c.pct)),
    r.comparisons.map((c) => c.step).join(","));
  ok("a missing step is not silently counted as a pass",
    !r.comparisons.find((c) => c.step === "dropped")?.actionable);
}
{
  const r = evaluateRegression({}, healthy(), REGRESSION);
  ok("no baseline steps -> unknown, not pass", r.verdict === "unknown", r.detail);
}
{
  // And the required-unknown regression rule blocks on its own.
  const report = buildGateReport(evaluateBudgets(healthy()), { verdict: "unknown", detail: "no baseline", comparisons: [] });
  ok("a required unknown regression blocks", report.release.blocked);
}

console.log("\n--- the budget table itself is well-formed ---");
{
  ok("every budget has a unique id", new Set(BUDGETS.map((b) => b.id)).size === BUDGETS.length);
  const missingBasis = BUDGETS.filter((b) => !b.basis || b.basis.trim().length < 20);
  ok("every budget records a real basis", missingBasis.length === 0, missingBasis.map((b) => b.id).join(","));
  const claimed = BUDGETS.filter((b) => b.evidence !== "unmeasured" && !Number.isFinite(b.limit));
  ok("no measured budget has an infinite limit", claimed.length === 0, claimed.map((b) => b.id).join(","));
  const throughput = BUDGETS.find((b) => b.id === "throughput.absolute");
  ok("throughput carries an explicit refusal, not a number",
    throughput?.evidence === "unmeasured" && /NOT CLAIMED/.test(throughput.basis));
  ok("the PRD's 10% is the stated rule", REGRESSION.maxPctIncrease === 10);
}

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
