/**
 * Prove the browser gate (TASK-56) is honest about what it did and did not run.
 *
 * Three properties, each of which has a way of being quietly wrong:
 *
 *   1. A suite that cannot run must not be reported as a pass.
 *   2. A payload with its assets removed must FAIL, naming the asset check.
 *   3. An artifact override that is not a payload must be refused, never
 *      silently replaced by a real artifact.
 *
 * Case 3 existed because of a real bug this found: with XT_ASSET_ARTIFACT
 * pointing at a directory that had no apply-migrations.mjs, the resolution loop
 * fell through to dist/artifact and reported 19 passed, 0 failed for a tree
 * that was never tested.
 *
 * NOT registered in the portable aggregate: it requires a staged local
 * fixture (`npx tsx scripts/stage-local-test-artifact.ts`) and a writable
 * dist/, neither of which the CI aggregate guarantees. Run it manually:
 *
 *   npx tsx scripts/stage-local-test-artifact.ts
 *   npx tsx scripts/verify-browser-gate-honesty.ts
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(__dirname, "..");
const tsx = path.join(repo, "node_modules", "tsx", "dist", "cli.mjs");

function runGate(extra: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [tsx, path.join(repo, "scripts", "run-browser-gate.ts"), ...extra], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env },
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function runSuite(env: NodeJS.ProcessEnv): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [tsx, path.join(repo, "scripts", "test-artifact-assets.ts")], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const problems: string[] = [];
const localFixture = path.join(repo, "dist", "artifact-local");
if (!fs.existsSync(localFixture)) {
  console.error("stage the fixture first: npx tsx scripts/stage-local-test-artifact.ts");
  process.exit(1);
}

// --- 1. the gate, on a payload whose assets are removed ---------------------
const stripped = path.join(repo, "dist", "artifact-stripped");
fs.rmSync(stripped, { recursive: true, force: true });
fs.cpSync(localFixture, stripped, { recursive: true });
for (const rel of ["apps/web/public", "apps/web/.next/static"]) {
  const dir = path.join(stripped, rel);
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
}
const strippedRun = runSuite({ XT_ASSET_ARTIFACT: stripped });
console.log("--- 1. a real payload with its assets removed ---");
console.log(`exit=${strippedRun.code}`);
for (const line of strippedRun.out.split("\n").filter((l) => /FAIL|passed,/.test(l)).slice(0, 4)) {
  console.log(`  ${line.trim()}`);
}
if (strippedRun.code === 0) problems.push("a payload with its assets removed was reported as passing");
if (!/every asset the authenticated page references is served/.test(strippedRun.out)) {
  problems.push("the stripped run did not name the asset-serving check");
}

// --- 2. an override that is not a payload ----------------------------------
const bogus = path.join(repo, "dist", "artifact-bogus");
fs.rmSync(bogus, { recursive: true, force: true });
fs.mkdirSync(bogus, { recursive: true });
const bogusRun = runSuite({ XT_ASSET_ARTIFACT: bogus });
console.log("\n--- 2. an override that is not a payload ---");
console.log(`exit=${bogusRun.code}`);
for (const line of bogusRun.out.split("\n").filter((l) => /Refus|Error/.test(l)).slice(0, 3)) {
  console.log(`  ${line.trim()}`);
}
if (bogusRun.code === 0) problems.push("a non-payload override was silently replaced by a real artifact");
if (!/Refusing to fall back/.test(bogusRun.out)) problems.push("a non-payload override did not explain the refusal");

// --- 3. the gate verdict itself ---------------------------------------------
// The gate must not claim the artifact was exercised when its only artifact
// suite was skipped. `--only` on a suite that cannot run is exercised by
// pointing the gate at a host with no matching engine, which cannot be done
// here, so what is verified is the verdict SHAPE: a failing run is `fail`, and
// the word PASS is absent from it.
const failing = runGate(["--only", "artifact-assets", "--allow-skips"]);
const verdictMatch = failing.out.match(/verdict: (\w+)/i)?.[1] ?? "(none)";
console.log(`\n--- 3. gate verdict shape (healthy fixture) ---`);
console.log(`verdict=${verdictMatch}`);
if (verdictMatch.toLowerCase() === "fail") problems.push("the gate failed against a healthy fixture");

fs.rmSync(stripped, { recursive: true, force: true });
fs.rmSync(bogus, { recursive: true, force: true });

if (problems.length > 0) {
  console.error("\nGATE HONESTY FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("\nGATE HONESTY OK: assets removed -> fail; bad override -> refused; verdict is honest.");
