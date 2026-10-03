/**
 * The release browser gate (TASK-56).
 *
 * Runs the browser suites in sequence and produces ONE machine-readable verdict
 * plus a sanitized log. The design constraint from the acceptance criteria is
 * "without requiring unavailable local infrastructure silently", which shapes
 * three decisions:
 *
 * 1. A suite that cannot run is a DISTINCT outcome, never a pass. Every suite
 *    exits 77 for "could not run here" (no Chromium, no build, no loopback).
 *    Collapsing 77 into 0 is the exact failure this task exists to prevent: it
 *    is how "browser coverage" gets claimed when only static inspection ran.
 *    `--allow-skips` downgrades skips to a warning, and is what CI uses on
 *    runners where Chromium cannot be installed -- but the verdict then records
 *    `partial`, never `pass`, and the release checklist has to say so.
 *
 * 2. Logs are sanitized on the way out. A failing browser suite can print a page
 *    dump, a request body, or an env line; those go through `scrub` before being
 *    written, so an evidence file never contains a session cookie, a password,
 *    or a database row.
 *
 * 3. The gate is explicit about WHICH runtime it exercised. Suites are tagged
 *    `source` (next start from the checkout) or `artifact` (the staged standalone
 *    release payload). A green run of only `source` suites is NOT evidence about
 *    the release, and the verdict says so.
 *
 * Run: npx tsx scripts/run-browser-gate.ts [--all] [--allow-skips] [--only <name>]
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(__dirname, "..");
const EXIT_SKIP = 77;

interface Suite {
  name: string;
  script: string;
  /** `artifact` = the staged release payload; `source` = next start. */
  runtime: "artifact" | "source";
  /** Browser suites need Chromium; the artifact suite does not. */
  needsBrowser: boolean;
  /** Why this suite is in the gate, recorded in the verdict. */
  covers: string;
}

const SUITES: Suite[] = [
  {
    name: "artifact-assets",
    script: "scripts/test-artifact-assets.ts",
    runtime: "artifact",
    needsBrowser: false,
    covers: "TASK-55: localized protected routes and every referenced asset served from the staged payload",
  },
  {
    // Source-static a11y. Kept in the gate because it is the only suite that
    // reads the shared component layer, and its absence was a real hole: a stale
    // assertion in it went unnoticed until TASK-71, and it had been red for an
    // unknown time with nothing reporting it.
    name: "a11y-baseline",
    script: "scripts/test-a11y-baseline.ts",
    runtime: "source",
    needsBrowser: false,
    covers: "TASK-46: WCAG 2.2 AA static baseline over shared controls (1.4.1 colour-only state, 2.4.7 focus ring, labels, error announcement)",
  },
  {
    name: "a11y-contrast",
    script: "scripts/test-a11y-contrast.ts",
    runtime: "source",
    needsBrowser: true,
    covers: "TASK-48: WCAG 2.2 AA contrast, target size, and reflow measured in a real browser (a source grep cannot answer these)",
  },
  {
    name: "dialog-keyboard",
    script: "scripts/test-dialog-keyboard.ts",
    runtime: "source",
    needsBrowser: true,
    covers: "TASK-47: dialog focus entry, focus trap, Escape close, and focus return to the invoking element",
  },
  {
    name: "state-a11y",
    script: "scripts/test-state-a11y.ts",
    runtime: "source",
    needsBrowser: true,
    covers: "TASK-50: accessible loading/empty/error states across eight routes, driven through real runtime transitions",
  },
  {
    name: "smoke-nodes-tunnels",
    script: "scripts/test-smoke-nodes-tunnels.ts",
    runtime: "source",
    needsBrowser: true,
    covers: "TASK-52: representative node and tunnel flows against a real build, on a disposable database",
  },
  {
    name: "smoke-tunnel-diagnostics",
    script: "scripts/test-smoke-tunnel-diagnostics.ts",
    runtime: "source",
    needsBrowser: true,
    covers: "TASK-54: tunnel diagnostics, including the stale-package false-pass guard on the tunnel-core dist/",
  },
  {
    name: "smoke-routes",
    script: "scripts/test-smoke-routes.ts",
    runtime: "source",
    needsBrowser: true,
    covers: "TASK-53 + the language switcher: every authenticated route in en/fa, locale switching, active-locale tick",
  },
  {
    name: "smoke-auth",
    script: "scripts/test-smoke-auth.ts",
    runtime: "source",
    needsBrowser: true,
    covers: "TASK-16: login, session, CSRF, and redirect behaviour",
  },
  {
    name: "smoke-fa",
    script: "scripts/test-smoke-fa.ts",
    runtime: "source",
    needsBrowser: true,
    covers: "Persian locale rendering and the fa catalogue",
  },
  {
    name: "rtl-browser",
    script: "scripts/test-rtl-browser.ts",
    runtime: "source",
    needsBrowser: true,
    covers: "TASK-49: computed direction, table action placement, viewport overflow, LTR leakage",
  },
  {
    name: "a11y-browser",
    script: "scripts/test-a11y-browser.ts",
    runtime: "source",
    needsBrowser: true,
    covers: "TASK-50/51: representative accessibility checks in a real browser",
  },
];

/**
 * Remove anything secret-shaped before a log is written anywhere.
 *
 * Deliberately pattern-based rather than "only log the summary": a browser suite
 * can print a full page on failure, and a page can contain a session value. The
 * patterns cover the shapes this app actually produces plus generic bearer/basic
 * auth, and the JWT shape is matched by structure so a rotated secret is still
 * caught.
 */
export function scrub(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/(authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, "$1: [REDACTED]")
    .replace(/\b(xt_access|session|sid|xsrf|csrf)[A-Za-z0-9_]*\s*=\s*[^\s;]+/gi, "[REDACTED_COOKIE]")
    .replace(/((?:password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]");
}

interface SuiteResult {
  name: string;
  runtime: Suite["runtime"];
  covers: string;
  outcome: "pass" | "fail" | "skip";
  exitCode: number;
  durationMs: number;
  passed: number | null;
  failed: number | null;
  reason: string;
  logFile: string;
}

/** The `N passed, M failed` line, which is the only trustworthy result signal. */
function parseSummary(log: string): { passed: number | null; failed: number | null } {
  const m = log.match(/(\d+)\s+passed,\s+(\d+)\s+failed/);
  if (!m) return { passed: null, failed: null };
  return { passed: Number(m[1]), failed: Number(m[2]) };
}

async function runSuite(suite: Suite, logDir: string): Promise<SuiteResult> {
  const logFile = path.join(logDir, `${suite.name}.log`);
  const started = process.hrtime.bigint();
  console.log(`\n--- ${suite.name} (${suite.runtime}) ---`);
  console.log(`    ${suite.covers}`);

  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), path.join(REPO, suite.script)],
    { cwd: REPO, env: { ...process.env, CI: process.env.CI ?? "" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const chunks: string[] = [];
  child.stdout?.on("data", (c: Buffer) => chunks.push(c.toString()));
  child.stderr?.on("data", (c: Buffer) => chunks.push(c.toString()));

  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      console.error(`    ${suite.name} exceeded 25 minutes; killing`);
      child.kill("SIGKILL");
    }, 25 * 60 * 1000);
    child.once("exit", (c) => {
      clearTimeout(timer);
      resolve(c ?? -1);
    });
  });

  const durationMs = Number((process.hrtime.bigint() - started) / 1_000_000n);
  const log = scrub(chunks.join(""));
  fs.writeFileSync(logFile, log, "utf8");

  const { passed, failed } = parseSummary(log);
  const outcome: SuiteResult["outcome"] = code === 0 ? "pass" : code === EXIT_SKIP ? "skip" : "fail";
  let reason = "";
  if (outcome === "skip") {
    // The skip reason is part of the evidence: "no browser" is a fact about the
    // runner that the release checklist has to be able to read.
    reason = log.split("\n").filter((l) => /SKIP|needs .*engine|cannot run|unavailable/i.test(l))[0]?.trim()
      ?? "exit 77 (could not run here)";
  } else if (outcome === "fail") {
    const fails = log.split("\n").filter((l) => l.includes("FAIL")).slice(0, 3).map((l) => l.trim());
    reason = fails.join(" | ") || `exit ${code} with no result summary`;
  } else if (passed === null) {
    // A zero exit with no summary is not a pass. It means the suite changed its
    // output format or died early, and treating it as green would let the gate
    // stop verifying anything while still reporting success.
    outcome = "fail";
    reason = "exit 0 but no `N passed, M failed` summary — the result is unverifiable";
  }

  const mark = outcome === "pass" ? "ok  " : outcome === "skip" ? "SKIP" : "FAIL";
  console.log(`    ${mark} ${suite.name}: ${outcome} (exit ${code}, ${(durationMs / 1000).toFixed(1)}s)`);
  if (passed !== null) console.log(`         ${passed} passed, ${failed} failed`);
  if (reason) console.log(`         ${reason}`);

  return { name: suite.name, runtime: suite.runtime, covers: suite.covers, outcome, exitCode: code, durationMs, passed, failed, reason, logFile };
}

function hostInfo(): Record<string, unknown> {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
    ci: process.env.CI === "true",
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const allowSkips = argv.includes("--allow-skips");
  const all = argv.includes("--all");
  const onlyIdx = argv.indexOf("--only");
  const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : undefined;

  let selected = SUITES;
  if (only) {
    selected = SUITES.filter((s) => s.name === only);
    if (selected.length === 0) {
      console.error(`no suite named ${only}. Known: ${SUITES.map((s) => s.name).join(", ")}`);
      process.exit(2);
    }
  } else if (!all) {
    // The default is the release-relevant subset. `--all` adds everything.
    selected = SUITES.filter((s) => s.runtime === "artifact" || s.name === "smoke-routes" || s.name === "a11y-browser");
  }

  const logDir = path.join(REPO, ".agent", "tmp-smoke", `gate-${Date.now().toString(36)}`);
  fs.mkdirSync(logDir, { recursive: true });

  console.log("=== xistance browser gate ===");
  console.log(`host: ${os.platform()} ${os.arch()}, ${os.cpus().length} vCPU, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB RAM`);
  console.log(`mode: ${only ? `only ${only}` : all ? "all suites" : "release subset"}${allowSkips ? ", skips allowed (partial)" : ""}`);
  console.log(`logs: ${path.relative(REPO, logDir)}`);

  const results: SuiteResult[] = [];
  for (const suite of selected) results.push(await runSuite(suite, logDir));

  const failed = results.filter((r) => r.outcome === "fail");
  const skipped = results.filter((r) => r.outcome === "skip");
  const passed = results.filter((r) => r.outcome === "pass");
  // `artifactCovered` is the fact that decides whether this gate is evidence
  // about the RELEASE. Six green source suites and no artifact run means the
  // release payload was never exercised.
  const artifactCovered = results.some((r) => r.runtime === "artifact" && r.outcome === "pass");

  const verdict: Record<string, unknown> = {
    schema: "xistance.browser-gate/1",
    verdict: failed.length > 0 ? "fail" : skipped.length > 0 ? (allowSkips ? "partial" : "incomplete") : "pass",
    host: hostInfo(),
    mode: { all, only: only ?? null, allowSkips },
    counts: { pass: passed.length, fail: failed.length, skip: skipped.length, total: results.length },
    artifactCovered,
    checks: results.map((r) => ({
      name: r.name,
      runtime: r.runtime,
      covers: r.covers,
      outcome: r.outcome,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      passed: r.passed,
      failed: r.failed,
      reason: r.reason,
      log: path.relative(REPO, r.logFile),
    })),
    // A run id ties this verdict to the logs without embedding anything secret.
    runId: randomBytes(6).toString("hex"),
  };

  const verdictFile = path.join(logDir, "verdict.json");
  fs.writeFileSync(verdictFile, `${JSON.stringify(verdict, null, 2)}\n`, "utf8");

  console.log(`\n=== gate verdict: ${String(verdict.verdict).toUpperCase()} ===`);
  console.log(`  ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
  console.log(`  artifact payload exercised: ${artifactCovered ? "yes" : "NO"}`);
  for (const r of skipped) console.log(`  skipped: ${r.name} — ${r.reason}`);
  for (const r of failed) console.log(`  failed:  ${r.name} — ${r.reason}`);
  console.log(`  verdict: ${path.relative(REPO, verdictFile)}`);

  if (failed.length > 0) process.exit(1);
  if (skipped.length > 0 && !allowSkips) {
    console.error(
      "\nSuites could not run. Re-run with --allow-skips to record this as `partial` instead of `incomplete`,\n" +
        "and do NOT record browser coverage for a partial or incomplete verdict.",
    );
    process.exit(EXIT_SKIP);
  }
  if (!artifactCovered) {
    console.error("\nNo artifact-runtime suite passed: this gate is not evidence about the release payload.");
    process.exit(1);
  }
}

// Only run when invoked directly. Without this, importing the module to reuse
// `scrub` starts a whole gate run as a side effect of the import -- which is how
// a scrub unit check ended up executing three browser suites before it printed
// anything.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  });
}
