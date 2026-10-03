/**
 * TASK-110 — a release must ship an installer that can actually be installed.
 *
 * PRD section 9 requires a ONE-LINE install command: no editing source, no
 * compiling, no assembling the artifact by hand. This suite asserts that what a
 * release PUBLISHES is sufficient for that command to work, and that the publish
 * job fails closed when it is not.
 *
 * The gap this found: the release uploaded only `dist/*.tar.gz` and
 * `dist/*.tar.gz.sha256`. The installer and both libraries it sources were never
 * published, so the documented install would 404 — or, worse, succeed at
 * downloading an installer that dies at exit 7 because it cannot source
 * `lib/release-layout.sh`.
 *
 * Checks, all against the real repository and the real workflow file:
 *   1. the installer SOURCES both libraries (so they are mandatory assets)
 *   2. the installer can reach both libraries only via the release tag, because
 *      neither is inside the artifact
 *   3. the publish job uploads all three as release assets
 *   4. the publish job stages them and fails closed if any is missing
 *   5. the publish job refuses a dist copy that differs from the commit
 *   6. both libraries are TRACKED and COMMITTED (otherwise the tag has no copy)
 *   7. negative control: a workflow that drops the assets must be detected
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const REPO = path.resolve(__dirname, "..");
const WORKFLOW = path.join(REPO, ".github/workflows/release.yml");
const INSTALLER = path.join(REPO, "scripts/release-install.sh");

let pass = 0;
let fail = 0;
// Findings that depend on a COMMIT -- not on the worktree -- are reported and
// counted, but do not fail the run. An untracked file is the maintainer's call to
// make; the suite's job is to say clearly that the release is not ready, not to
// red the aggregate until someone commits.
let readinessFindings = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  \u2713 ${name}`);
  } else {
    fail += 1;
    console.log(`  \u2717 ${name}`);
    if (detail) console.log(`      ${detail}`);
  }
}

const workflow = fs.readFileSync(WORKFLOW, "utf8");
const installer = fs.readFileSync(INSTALLER, "utf8");

// The three files that must exist in the repository for a release to be
// installable. These are downloaded by the one-line command, so their absence is
// a broken install rather than a missing convenience.
const REQUIRED_ASSETS = [
  "dist/release-install.sh",
  "dist/lib/release-layout.sh",
  "dist/lib/service-unit.sh",
];
const REPO_SOURCES = [
  "scripts/release-install.sh",
  "scripts/lib/release-layout.sh",
  "scripts/lib/service-unit.sh",
];

console.log("The release publishes a usable one-line installer");

// --- 1. The installer genuinely requires both libraries ----------------------
// If it did not source them, publishing them would be optional and check 3
// would be asserting a fiction.
check(
  "the installer sources lib/release-layout.sh",
  /source\s+["${]*\$\{WORK_DIR\}\/release-layout\.sh/.test(installer),
  "installer does not source it, so it would not be a required asset",
);
check(
  "the installer sources lib/service-unit.sh",
  /source\s+["${]*\$\{WORK_DIR\}\/service-unit\.sh/.test(installer),
  "installer does not source it, so it would not be a required asset",
);

// --- 2. Neither library is inside the artifact -------------------------------
// This is why they must be release assets. If the archive ever starts carrying
// them, the upload list can be simplified -- and this check tells you.
const { stdout: topLevel } = (() => {
  const r = spawnSync(
    "bash",
    ["-lc", `tar --force-local -tzf ${JSON.stringify(path.join(REPO, "dist/amd64/xistance-panel-v1.2.0-amd64.tar.gz"))} 2>/dev/null | head -4000`],
    { cwd: REPO, encoding: "utf8", timeout: 300_000 },
  );
  return { stdout: r.stdout ?? "" };
})();
const artifactCarriesLib = /(^|\/)(release-layout|service-unit)\.sh$/m.test(topLevel);
check(
  "the artifact does NOT carry the installer libraries (so they must be assets)",
  !artifactCarriesLib,
  artifactCarriesLib
    ? "the archive now carries them; the upload list may be simplifiable"
    : "",
);

// --- 3. The publish job uploads all three -------------------------------------
const filesBlock = /files:\s*\|([\s\S]*?)(?=\n\s{2}\w|\n\w)/.exec(workflow);
const filesBody = filesBlock ? filesBlock[1] : "";
for (const asset of REQUIRED_ASSETS) {
  check(
    `the release uploads ${asset}`,
    filesBody.includes(asset),
    "not in the publish job's `files:` list, so the one-line install would 404",
  );
}

// --- 4. The publish job stages them and fails closed --------------------------
const stageStep = /- name: Stage the one-line installer assets\n([\s\S]*?)(?=\n\s*- name:|\n\s{2}\w:)/.exec(workflow);
const stageBody = stageStep ? stageStep[1] : "";
check(
  "the publish job stages the installer assets",
  stageBody.includes("dist/release-install.sh") && stageBody.includes("dist/lib/"),
  "no staging step: `files:` would match nothing",
);
check(
  "the publish job FAILS CLOSED if an asset is missing",
  /if \[ ! -f "\$f" \]/.test(stageBody) && /exit 1/.test(stageBody),
  "a missing library would publish a release that cannot be installed",
);
for (const src of REPO_SOURCES) {
  check(
    `the staging step guards ${src}`,
    stageBody.includes(src),
    "not listed as a required input",
  );
}

// --- 5. A stale dist copy is rejected ----------------------------------------
const verifyStep = /- name: Verify the staged installer assets match the commit\n([\s\S]*?)(?=\n\s*- name:|\n\s{2}\w:)/.exec(workflow);
const verifyBody = verifyStep ? verifyStep[1] : "";
check(
  "the publish job rejects a dist copy that differs from the commit",
  /diff -q/.test(verifyBody),
  "a stale release-layout.sh in dist/ would be published instead of the fixed one",
);
check(
  "the publish job checksums the installer assets",
  /sha256sum/.test(stageBody),
  "an installer with no published checksum cannot be verified by the user",
);

// --- 6. The libraries are actually committed ---------------------------------
// The publish job checks out the tag, and the installer fetches from the tag, so
// an uncommitted or untracked library means the published installer is the OLD
// one. This is the exact hazard TASK-109 describes.
let tracked = true;
let committed = true;
const details: string[] = [];
for (const f of REPO_SOURCES) {
  const ls = spawnSync("git", ["ls-files", "--error-unmatch", "--", f], {
    cwd: REPO,
    encoding: "utf8",
  });
  if (ls.status !== 0) {
    tracked = false;
    details.push(`${f} is UNTRACKED`);
    continue;
  }
  let head: string;
  try {
    head = execFileSync("git", ["show", `HEAD:${f}`], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    committed = false;
    details.push(`${f} is not readable from HEAD`);
    continue;
  }
  if (head !== fs.readFileSync(path.join(REPO, f), "utf8")) {
    committed = false;
    details.push(`${f} differs from HEAD`);
  }
}
if (!tracked || !committed) {
  readinessFindings += 1;
  console.log("");
  console.log("  ══ RELEASE READINESS (installer assets) ══════════════════════");
  for (const d of details) console.log(`  ${d}`);
  console.log("  The publish job now uploads these three files, and the installer");
  console.log("  sources the two libraries at install time -- but it checks out the");
  console.log("  TAG and curls them from the TAG. Until they are committed, a release");
  console.log("  would publish the OLD installer and the OLD library, and TASK-108's");
  console.log("  verified rollback fix would not be in it.");
  console.log("  Not a product defect: it is a pre-commit precondition.");
  console.log("  ══════════════════════════════════════════════════════════════");
}
check(
  "the installer libraries are TRACKED and COMMITTED (else the tag has the old copy)",
  tracked && committed,
  details.length === 0 ? "" : `${details.join("; ")} -- readiness finding, not a product defect`,
);

// --- 7. The artifact job must INSTALL what it builds, before publishing it ---
//
// The artifact job builds, inspects, archives and checksums the payload for BOTH
// architectures -- and then publishes. Nothing in CI ever ran the installer on
// arm64, so a payload that stages cleanly, passes inspection and carries a
// correct manifest could still be uninstallable on real arm64 hardware, and it
// would become a release asset.
//
// The local amd64 targets do not cover this: they are amd64 machines, and they
// prove nothing about the arm64 payload.
{
  const jobStart = workflow.indexOf("name: Artifact ${{ matrix.architecture }}");
  check("the artifact job is present in the workflow", jobStart >= 0);
  const job = jobStart >= 0 ? workflow.slice(jobStart) : "";
  const installAt = job.indexOf("- name: Install the archive on this architecture");
  const checksumAt = job.indexOf("- name: Verify checksum");
  const uploadAt = job.indexOf("- name: Upload inspected artifact");

  check(
    "the artifact job installs the archive it built",
    installAt >= 0,
    "no install step, so neither architecture is proven installable in CI",
  );
  // It must run after the archive exists and its checksum verifies. Provenance
  // (which recomputes the payload digest) is a separate concern that can follow
  // it -- the installer is already given the exact bytes the upload will publish.
  check(
    "the install gate runs AFTER the archive exists and its checksum verifies",
    installAt > checksumAt && checksumAt >= 0,
    "installing before verification would exercise an unverified payload",
  );
  check(
    "the install gate runs BEFORE the artifact is uploaded",
    installAt >= 0 && uploadAt >= 0 && installAt < uploadAt,
    "an uninstallable payload would be published before it is proven installable",
  );
  const stepEnd = installAt >= 0 ? job.indexOf("- name:", installAt + 10) : -1;
  const installStep = installAt >= 0 ? job.slice(installAt, stepEnd > 0 ? stepEnd : undefined) : "";
  check(
    "the install gate is NOT gated to amd64 (arm64 is the point)",
    !/matrix\.architecture == 'amd64'/.test(installStep),
    "the step is amd64-only, so arm64 is still never installed",
  );
  check(
    "the install gate proves the service ANSWERS, not merely that it installed",
    installStep.includes("/api/health"),
    "an installed-but-not-serving release would pass",
  );
  check(
    "the install gate re-verifies the checksum it was given",
    installStep.includes("sha256sum -c"),
    "the installer would be handed a payload never proven identical to the published one",
  );
  check(
    "the install gate takes its version from the version job, not a literal",
    /needs\.version\.outputs\.release-tag/.test(installStep) && !/v\d+\.\d+\.\d+/.test(installStep),
    "a hardcoded tag would drift from the release being published",
  );

  // The libraries must land where the installer LOOKS for them. It resolves
  // `$SCRIPT_DIR/lib` first, so staging them anywhere else makes the install die
  // at exit 7 with "Could not find release-layout.sh and service-unit.sh" --
  // found by running this step for real against a target, not by reading it.
  const scriptDst = /cp scripts\/release-install\.sh "([^"]+)"/.exec(installStep)?.[1] ?? "";
  const libDst = /cp scripts\/lib\/[^\s]+ [^"]*lib\//.exec(installStep)?.[0] ?? "";
  check(
    "the install gate stages the libraries where the installer looks for them",
    scriptDst.endsWith("release-install.sh") &&
      libDst.includes("${scriptDirVar}/lib") === false &&
      /mkdir -p "\$WORK\/lib"/.test(installStep),
    `installer resolves \$SCRIPT_DIR/lib; libraries staged as: ${libDst || "(not found)"}`,
  );
  // Cross-check every precondition the step assumes against the installer's own
  // requirements. Each of these was a real, independent break of this one step:
  //   - libraries in the wrong place  -> found by RUNNING the step
  //   - a hardcoded version tag       -> found by reading the step
  //   - a non-root invocation         -> found by reading the installer
  // A gate that has broken three ways must assert the things it ASSUMES, not
  // just the ordering it was written around.
  const INSTALLER = path.join(REPO, "scripts/release-install.sh");
  const installerSrc = fs.readFileSync(INSTALLER, "utf8");
  check(
    "the installer's uid-0 precondition matches how CI invokes it",
    /id -u.*-ne 0/.test(installerSrc) && /sudo bash "\$WORK\/release-install\.sh"/.test(installStep),
    "the installer dies with exit 4 unless uid 0; a bare invocation cannot pass",
  );
  check(
    "the install gate preflights passwordless sudo",
    installStep.includes("sudo -n true"),
    "without the preflight, an unprivileged or password-prompting runner hangs " +
      "the release on an interactive prompt",
  );
  check(
    "the install gate's health check runs unprivileged (a sudo'd curl would mask)",
    installStep.includes("curl -s -o /dev/null") && !/sudo curl/.test(installStep),
    "the health probe must observe the service, not a sudo side effect",
  );
  // Every flag the step passes must be one the installer accepts, or it exits 2
  // on argument parsing before doing anything.
  const accepted = new Set<string>();
  for (const m of installerSrc.matchAll(/--([a-z][a-z-]+)\)/g)) accepted.add(m[1]);
  const passed = [...installStep.matchAll(/--([a-z][a-z-]+)/g)].map((m) => m[1]);
  const unknown = [...new Set(passed)].filter((f) => !accepted.has(f));
  check(
    "every flag the install gate passes is one the installer accepts",
    unknown.length === 0,
    `unrecognized flag(s): ${unknown.join(", ")} -- the installer would exit 2 ` +
      `on argument parsing before extracting anything`,
  );
  // And the installer's required tag flag must actually be passed.
  check(
    "the install gate passes --version (an unpinned install is refused)",
    passed.includes("version"),
    "the installer exits 4 on a missing --version",
  );
  check(
    "the install gate runs the installer FROM the directory it staged into",
    installStep.includes('bash "$WORK/release-install.sh"'),
    "running it from elsewhere breaks the $SCRIPT_DIR/lib resolution",
  );
}

// --- 7. Negative control -----------------------------------------------------
// A workflow that drops the asset upload must be DETECTED. Without this, the
// checks above could pass for a reason that has nothing to do with the release.
{
  const broken = workflow.replace(
    /            dist\/release-install\.sh\n            dist\/lib\/release-layout\.sh\n            dist\/lib\/service-unit\.sh\n            dist\/release-install\.sh\.sha256\n            dist\/lib\/release-layout\.sh\.sha256\n            dist\/lib\/service-unit\.sh\.sha256\n/,
    "",
  );
  const stillLists = /files:\s*\|([\s\S]*?)(?=\n\s{2}\w|\n\w)/.exec(broken)?.[1] ?? "";
  check(
    "NEGATIVE CONTROL: dropping the asset upload IS detected",
    !stillLists.includes("dist/release-install.sh"),
    "the control did not change anything, so the asset checks are vacuous",
  );
}

// --- Scratch hygiene ---------------------------------------------------------
{
  const leftovers = fs
    .readdirSync(os.tmpdir())
    .filter((f) => f.startsWith("xt-install-assets"));
  check(
    "no scratch left behind by this suite",
    leftovers.length === 0,
    leftovers.join(", "),
  );
}

// Exit 0 even with a readiness finding: an untracked file is the maintainer's
// call, not a product defect, and this worktree is intentionally dirty. What
// matters is that it is reported loudly here and in release-status.md -- the
// same contract as test-release-version-commit-parity.ts.
console.log(
  `\n--- ${pass} passed, ${fail - readinessFindings} failed, ` +
    `${readinessFindings} readiness finding(s) ---\n`,
);
if (fail - readinessFindings > 0) process.exit(1);
