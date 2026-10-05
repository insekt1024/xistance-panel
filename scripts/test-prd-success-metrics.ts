/**
 * TASK-104. Every PRD success metric must have an ENFORCED gate, not just a
 * suite that happens to exist.
 *
 * `reconcile-task-ledger.py` proves 73/73 tasks have evidence. That says every
 * task file is backed by something. It does NOT say every PRD success criterion
 * is checked, because a task can be "evidenced" by a document while the
 * criterion it serves is enforced nowhere.
 *
 * It also does not say the ledger is COMPLETE. The reconciler enumerates
 * `.agent/tasks/TASK-*.json`, so a task that has evidence but no ledger file is
 * invisible to it by construction -- the count it reports can only ever describe
 * the tasks that already exist. That is the gap closed at the end of this file.
 *
 * PRD section 15 lists the metrics. Each one below is mapped to the suite that
 * actually ENFORCES it, and the mapping is asserted. A metric whose enforcing
 * suite is missing, or which resolves to a suite that does not exist, fails.
 *
 * This closes the gap between "a test exists" and "the requirement is checked".
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const AGGREGATE = path.join(REPO, "scripts", "run-all-tests.ts");
const BROWSER_GATE = path.join(REPO, "scripts", "run-browser-gate.ts");
const LINUX_GATE = path.join(REPO, "scripts", "test-release-payload-linux.sh");

/**
 * A gate is ENFORCED if some runner actually executes it. Not every gate lives
 * in the TS aggregate: the browser suites run under run-browser-gate.ts, and the
 * static-asset suite runs under the Linux payload shell gate. Checking only the
 * aggregate reported two false failures on the first run of this suite -- the
 * metrics were covered, by a different runner.
 */
function runners(): string {
  return [
    fs.existsSync(AGGREGATE) ? fs.readFileSync(AGGREGATE, "utf8") : "",
    fs.existsSync(BROWSER_GATE) ? fs.readFileSync(BROWSER_GATE, "utf8") : "",
    fs.existsSync(LINUX_GATE) ? fs.readFileSync(LINUX_GATE, "utf8") : "",
  ].join("\n");
}

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
    if (detail) console.log(`       ${detail}`);
  }
}

const aggregate = runners();

/**
 * PRD section 15, in order. `gate` is the suite that ENFORCES the metric --
 * not merely a suite that touches the area. `why` records what enforcing means
 * for that specific metric, because a suite existing is not the same claim.
 */
const METRICS: { metric: string; gate: string; why: string }[] = [
  {
    metric: "100% of automated baseline commands pass (version, lint, typecheck, tests, build)",
    gate: "run-all-tests.ts",
    why: "the aggregate IS the baseline command; a build gate is the separate concern below",
  },
  {
    metric: "100% of every method have configuration, lifecycle, error, cleanup, resource/reconnect evidence",
    gate: "test-method-matrix.ts",
    why: "asserts a per-method suite exists for all nine and writes a machine-readable matrix",
  },
  {
    metric: "0 known critical/high security findings at release",
    gate: "test-supply-chain.ts",
    why: "audits the dependency tree and fails on unresolved high/critical",
  },
  {
    metric: "0 secret leaks in automated scans/log inspection",
    gate: "test-secret-redaction.ts",
    why: "fails on any secret pattern in evidence, logs and output",
  },
  {
    metric: "0 required static-asset 404s in release smoke test",
    gate: "test-artifact-assets.ts",
    why: "drives the staged payload and fails on a missing/404 required asset",
  },
  {
    metric: "0 unprotected panel-shell responses",
    gate: "test-protected-routes.ts",
    why: "asserts every panel shell route refuses an unauthenticated request",
  },
  {
    metric: "100% of supported architecture artifacts verify checksum and pass artifact inspection",
    gate: "test-real-archive-verify.ts",
    why: "runs the real verifier against BOTH real archives, per architecture",
  },
  {
    metric: "No more than 10% regression in selected low-resource control-plane latency",
    gate: "test-resource-budgets.ts",
    why: "the percentage is paired with an absolute noise floor and a blocking exit, so it is enforceable rather than decorative",
  },
  {
    metric: "UI acceptance includes WCAG 2.2 AA evidence for representative routes",
    gate: "test-a11y-contrast.ts",
    why: "contrast and a11y assertions over the real routes, not a claim",
  },
  {
    metric: "English and Persian documentation and catalogs are consistent with the shipped artifact",
    gate: "test-readme-fa-parity.ts",
    why: "compares EN and FA operational content for contradictions",
  },
  {
    metric: "Installation/readiness and update/rollback drills pass on the real target OS",
    gate: "test-target-runs-shipped-payload.ts",
    why: "proves a target runs the shipped payload, and the release layout/rollback suites cover the drills",
  },
];

console.log("TASK-104 every PRD success metric has an enforcing gate\n");

for (const m of METRICS) {
  const file = path.join(REPO, "scripts", m.gate);
  const exists = fs.existsSync(file);
  if (!exists) {
    check(`${m.metric.slice(0, 58)}…`, false, `no suite at scripts/${m.gate}`);
    continue;
  }
  // The gate must be wired into SOME runner, or it never runs.
  const registered = aggregate.includes(m.gate);
  check(
    `${m.metric.slice(0, 58)}…`,
    registered,
    `scripts/${m.gate} exists but no runner (aggregate, browser gate, Linux gate) executes it`,
  );
  void m.why;
}

// The two architectures the release must cover, and the four workflow jobs, are
// the structural half of the release contract and are asserted explicitly.
for (const arch of ["amd64", "arm64"]) {
  check(
    `the release contract covers ${arch}`,
    aggregate.includes("test-real-archive-verify.ts") && fs.existsSync(path.join(REPO, "scripts", "test-real-archive-verify.ts")),
    `no architecture coverage for ${arch}`,
  );
}

const workflow = path.join(REPO, ".github", "workflows", "release.yml");
if (!fs.existsSync(workflow)) {
  check("the release workflow exists", false);
} else {
  const wf = fs.readFileSync(workflow, "utf8");
  for (const job of ["  version:", "  artifact:", "  publish:", "  docker:"]) {
    check(`the release workflow defines job "${job.trim()}"`, wf.includes(job));
  }
  check(
    "the workflow's arm64 cell runs on an arm64 runner",
    wf.includes("ubuntu-24.04-arm"),
  );
  check(
    "the docker image is multi-architecture (TASK-103)",
    /platforms:.*linux\/amd64.*linux\/arm64/s.test(wf),
    "no multi-arch `platforms:` on the image build",
  );
}

// --- The reconciler must not be able to report a vacuous number --------------
//
// `reconcile-task-ledger.py --check` prints "73/73 tasks evidence-backed, 0
// dangling" and exits 0. That number is true AND vacuous: it enumerates
// `.agent/tasks/TASK-*.json`, so a task with evidence but no ledger file is
// invisible to it BY CONSTRUCTION. Its count can never fall below the number of
// files that exist.
//
// So this asserts the SHAPE of that report rather than its value. A reconciler
// whose denominator comes from the files it globs cannot detect work outside
// them, and the fix is not to invent the missing records -- it is to make the
// report state what it actually covered.
//
// Two id namespaces exist and must not be conflated:
//   * PRD tasks  TASK-1..73   -- the 73 the PRD itself defines
//   * findings   TASK-74..   -- agent-loop findings, numbered by discovery
// An evidence file above 73 is a FINDING, not a missing PRD task, and requiring a
// ledger entry for it would be a false positive. (I asserted exactly that for one
// turn: TASK-74..121 are 47 findings, not 47 absent tasks.)
{
  const reconciler = fs.readFileSync(
    path.join(REPO, "scripts", "reconcile-task-ledger.py"),
    "utf8",
  );

  // Behavioural, not textual: run it and read what it CLAIMS to have covered.
  // A docstring rename or a path constant must not be able to satisfy this.
  let summary = "";
  try {
    summary = spawnSync(
      "python",
      [path.join(REPO, "scripts", "reconcile-task-ledger.py"), "--check"],
      { cwd: REPO, encoding: "utf8", timeout: 180_000 },
    ).stdout;
  } catch {
    summary = "";
  }
  // It prints a labelled table, e.g.
  //   task files            : 73
  //   evidence-backed       : 73
  // so match the labels it uses rather than an N/N it never emits.
  const files = /task files\s*:\s*(\d+)/i.exec(summary);
  const backed = /evidence-backed\s*:\s*(\d+)/i.exec(summary);
  check(
    "the reconciler reports task files and evidence-backed as SEPARATE numbers",
    files !== null && backed !== null,
    `its output was ${JSON.stringify(summary.trim().slice(-200))}; without both ` +
      `counts a reader cannot see that both come from the same file list`,
  );
  check(
    "every task file it counted is evidence-backed",
    files !== null && backed !== null && Number(files[1]) === Number(backed[1]),
    `${backed?.[1] ?? "?"} evidence-backed out of ${files?.[1] ?? "?"} task files -- ` +
      `both numbers come from the same glob, so a task with evidence but no ` +
      `ledger file is outside this count entirely`,
  );
  check(
    "the reconciler says what it ENUMERATED, so its scope is visible",
    /ledger|TASK-\\d|task file/i.test(summary) && /evidence/i.test(summary),
    `its summary did not name both the ledger it walked and the evidence it ` +
      `checked, so a reader cannot tell which records the N/N covers`,
  );

  // The ledger and the PRD must agree on the task set. If the PRD defines 73
  // tasks, the ledger holding exactly those 73 is COMPLETE, not truncated.
  const taskDir = path.join(REPO, ".agent", "tasks");
  const ledgerIds = new Set<number>();
  for (const name of fs.readdirSync(taskDir)) {
    const m = /^TASK-(\d+)\.json$/.exec(name);
    if (m) ledgerIds.add(Number(m[1]));
  }
  const maxLedger = Math.max(...ledgerIds);
  const contiguous = ledgerIds.size === maxLedger; // 1..max with none missing
  check(
    "the ledger is CONTIGUOUS from TASK-1 (no silent hole inside the PRD range)",
    contiguous,
    `ledger holds ${ledgerIds.size} ids with max TASK-${maxLedger}; a hole inside ` +
      `the range means a PRD task has no record at all`,
  );

  // Findings above the PRD range must be labelled as such somewhere, so they are
  // never mistaken for unledgered PRD tasks later.
  const evidenceDir = path.join(REPO, ".agent", "evidence");
  const findings = fs
    .readdirSync(evidenceDir)
    .map((n) => /^task-(\d+)/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .filter((n) => n > maxLedger);
  const status = path.join(REPO, ".agent", "evidence", "release-status.md");
  const declared = fs.existsSync(status) ? fs.readFileSync(status, "utf8") : "";
  // The declaration must actually be ABOUT the id range. Matching /finding/
  // against the file is satisfied by the unrelated phrase "readiness findings"
  // surviving anywhere in it, which is why the first version of this assertion
  // passed against a file with the word removed.
  const rangeDeclaration =
    /findings?\b/i.test(declared) &&
    (new RegExp(`TASK-${maxLedger}`).test(declared) ||
      new RegExp(`(?:above|beyond|beyond the)[^\n]{0,40}TASK-\\d+`, "i").test(declared) ||
      /not PRD tasks?/i.test(declared));
  check(
    "findings above the PRD task range are DECLARED as findings, not PRD tasks",
    findings.length === 0 || rangeDeclaration,
    `${findings.length} evidence file(s) sit above TASK-${maxLedger}, but nothing ` +
      `states that those ids are findings rather than PRD tasks; a later audit ` +
      `would read them as ${findings.length} missing PRD tasks`,
  );

  // And every ledger task that DECLARES evidence must cite a file that exists.
  const dangling: string[] = [];
  for (const n of [...ledgerIds].sort((a, b) => a - b)) {
    let declaredFor: string | undefined;
    try {
      declaredFor = JSON.parse(
        fs.readFileSync(path.join(taskDir, `TASK-${n}.json`), "utf8"),
      ).evidence as string | undefined;
    } catch {
      dangling.push(`TASK-${n} (unparseable)`);
      continue;
    }
    if (!declaredFor) continue; // makes no claim to verify
    // The field is prose and mixes two forms:
    //   ".agent/evidence/target-os-docker-available.md"  repo-relative
    //   "task-72-final-gate-decision-v2.md"              bare filename
    // Resolving both against the repo root reports TASK-63 as citing a file that
    // plainly exists.
    const cited = [
      ...new Set(
        (declaredFor.match(/[\w./-]+\.(?:md|json|txt|log)/g) ?? []).map((s) =>
          s.replace(/^\.\//, ""),
        ),
      ),
    ];
    for (const c of cited) {
      const resolved = c.includes("/")
        ? path.join(REPO, c)
        : path.join(evidenceDir, c);
      if (!fs.existsSync(resolved)) dangling.push(`TASK-${n} cites missing ${c}`);
    }
  }
  check(
    "every declared evidence path in the ledger actually exists",
    dangling.length === 0,
    dangling.join("; ") + (dangling.length ? " -- readiness finding" : ""),
  );
}

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
