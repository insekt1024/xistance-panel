/**
 * Release gate for the low-resource budgets (TASK-60).
 *
 *   npx tsx scripts/resource-gate.ts --result <bench.json> [--baseline <bench.json>]
 *
 * Exit codes are the contract, so they are explicit on every path (a
 * process.exitCode assignment can be lost under tsx's async completion order):
 *
 *   0  every required budget passed
 *   1  a required budget failed, or a required one is unknown
 *   2  usage error / the input could not be read
 *   3  the run is not comparable to its baseline (different host or workload)
 *
 * A missing or unreadable result is a usage error, never a pass. An unknown on a
 * required budget exits 1, not 0: "we did not measure it" must never be
 * indistinguishable from "it is within budget".
 */
import fs from "node:fs";
import path from "node:path";
import { BUDGETS, REGRESSION, buildGateReport, evaluateBudgets, evaluateRegression } from "./lib/resource-budgets";

const EXIT_OK = 0;
const EXIT_BLOCKED = 1;
const EXIT_USAGE = 2;
const EXIT_NOT_COMPARABLE = 3;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function die(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

function readJson(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) die(EXIT_USAGE, `no such file: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    die(EXIT_USAGE, `could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function main(): void {
  const resultPath = arg("result");
  if (!resultPath) {
    die(EXIT_USAGE, "usage: npx tsx scripts/resource-gate.ts --result <bench.json> [--baseline <bench.json>]");
  }
  const result = readJson(resultPath);
  const baselinePath = arg("baseline");

  const budgets = evaluateBudgets(result, BUDGETS);
  let regression: ReturnType<typeof evaluateRegression> = {
    verdict: "unknown",
    detail: "no baseline supplied, so the regression rule could not be applied",
    comparisons: [],
  };

  if (baselinePath) {
    const baseline = readJson(baselinePath);
    // Comparability is the baseline's own check, and it is a hard stop: a 10%
    // rule applied across two different hosts measures the hosts, not the code.
    const bHost = (baseline.host as { comparable?: string } | undefined)?.comparable;
    const cHost = (result.host as { comparable?: string } | undefined)?.comparable;
    const bDigest = (baseline.workload as { digest?: string } | undefined)?.digest;
    const cDigest = (result.workload as { digest?: string } | undefined)?.digest;
    const mismatches: string[] = [];
    if (bHost !== cHost) mismatches.push(`host: ${String(bHost)} vs ${String(cHost)}`);
    if (bDigest !== cDigest) mismatches.push(`workload: ${String(bDigest)} vs ${String(cDigest)}`);
    if (mismatches.length > 0) {
      console.error(`\nrefusing to compare runs that are not equivalent:\n  ${mismatches.join("\n  ")}`);
      process.exit(EXIT_NOT_COMPARABLE);
    }
    regression = evaluateRegression(baseline, result, REGRESSION);
  }

  const report = buildGateReport(budgets, regression);

  console.log(`\n=== low-resource budgets (${path.basename(resultPath)}) ===`);
  const host = (result.host as { comparable?: string; platform?: string; arch?: string } | undefined);
  console.log(`host: ${host?.comparable ?? "unknown"}`);
  const art = result.artifact as { isReleasePayload?: boolean; path?: string } | undefined;
  if (art?.isReleasePayload === false) {
    console.log("artifact: NOT the release payload (local fixture) -- these numbers are not a release claim");
  }
  for (const b of report.budgets) {
    const tag = b.verdict.toUpperCase().padEnd(7);
    const req = b.required ? "required" : "advisory";
    console.log(`  ${tag} ${b.id.padEnd(20)} ${b.detail}  [${req}, ${b.evidence}]`);
  }

  console.log(
    `\n=== regression (PRD rule: <=${REGRESSION.maxPctIncrease}%, ` +
      `and only counts above a ${REGRESSION.minAbsoluteChangeMs}ms noise floor) ===`,
  );
  console.log(`  ${regression.verdict.toUpperCase().padEnd(7)} ${regression.detail}`);
  for (const c of regression.comparisons) {
    if (Number.isNaN(c.pct)) {
      console.log(`         ${c.step.padEnd(20)} absent from the baseline (${c.baselineP50.toFixed(1)}ms there)`);
    } else {
      // The marker is what stops a reader assuming every over-10% line is a
      // failure. It says the change was over the percentage but under the floor.
      const mark = c.actionable === true ? " <-- ACTIONABLE" : c.pct > REGRESSION.maxPctIncrease ? " (under noise floor)" : "";
      console.log(
        `         ${c.step.padEnd(20)} ${c.baselineP50.toFixed(1)}ms -> ${c.candidateP50.toFixed(1)}ms  ` +
          `${c.pct >= 0 ? "+" : ""}${c.pct.toFixed(1)}%${mark}`,
      );
    }
  }

  console.log(
    `\nsummary: ${report.summary.pass} pass, ${report.summary.fail} fail, ` +
      `${report.summary.unknown} unknown (${report.summary.requiredUnknown} required)`,
  );
  if (report.release.blocked) {
    console.log("\nRELEASE BLOCKED:");
    for (const r of report.release.reasons) console.log(`  - ${r}`);
  } else {
    console.log("\nrelease gate: PASS (every required budget is measured and within limit)");
  }
  process.exit(report.release.blocked ? EXIT_BLOCKED : EXIT_OK);
}

main();
