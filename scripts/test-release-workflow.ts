/**
 * Focused TASK-8 tests for the release workflow contract.
 * Parses the real workflow YAML and asserts the architecture matrix, staging,
 * inspection, manifest, and checksum stages exist.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  strategy?: { matrix?: Record<string, unknown> };
  permissions?: Record<string, string>;
  "runs-on"?: string;
  steps?: WorkflowStep[];
  needs?: string | string[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
  permissions?: Record<string, string>;
}

const repoRoot = path.resolve(__dirname, "..");

const REQUIRED_ARCHITECTURES = ["amd64", "arm64"] as const;

/**
 * Evaluate a `runs-on` expression the way GitHub Actions does, for one value
 * of matrix.runner_arch, and return the runner label it selects.
 *
 * GitHub Actions `a && b || c` is the ternary idiom: return b when a is
 * truthy, else c. Only the `&&`/`||` form is understood; any other expression
 * (a bare `matrix.runner_arch`, a function call, an unknown construct) returns
 * null so callers can reject it rather than accept a string that merely looks
 * right. Checking the string for "arm" is not enough: an expression can name
 * an arm runner in a branch it never takes.
 */
function resolveRunsOnFor(runsOn: string, runnerArch: string): string | null {
  const expr = runsOn.trim();
  if (!expr.includes("${{") || !expr.includes("}}")) return null;

  const body = expr.slice(expr.indexOf("${{") + 3, expr.lastIndexOf("}}")).trim();
  if (!body.includes("&&") || !body.includes("||")) return null;

  // Split on the top-level `&&` then `||`; GitHub's form is `cond && a || b`.
  const orParts = body.split("||").map((part) => part.trim());
  if (orParts.length !== 2) return null;
  const [andPart, fallbackRaw] = orParts;

  const andParts = andPart.split("&&").map((part) => part.trim());
  if (andParts.length !== 2) return null;
  const [condRaw, whenTrueRaw] = andParts;

  const cond = condRaw
    .replace(/^matrix\./, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
  const whenTrue = whenTrueRaw.replace(/^['"]|['"]$/g, "").trim();
  const fallback = fallbackRaw.replace(/^['"]|['"]$/g, "").trim();

  // The condition may compare the key to a value (`matrix.runner_arch ==
  // 'arm64'`) rather than name it bare. Extract the key and the value it is
  // compared against, so the caller can ask "what does this select when
  // runner_arch is X?" precisely.
  const comparison = cond.match(/^(\w+)\s*==\s*['"]?(\w+)['"]?$/);
  if (comparison) {
    const [, key, comparedValue] = comparison;
    if (key !== "runner_arch") return null;
    return comparedValue === runnerArch ? whenTrue : fallback;
  }
  if (cond !== "runner_arch") return null;
  return runnerArch === "arm64" ? whenTrue : fallback;
}

function allRunText(workflow: Workflow): string {
  const chunks: string[] = [];
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) if (typeof step.run === "string") chunks.push(step.run);
  }
  return chunks.join("\n");
}

function findStepAnywhere(workflow: Workflow, matcher: RegExp): WorkflowStep | undefined {
  for (const job of Object.values(workflow.jobs ?? {})) {
    const hit = (job.steps ?? []).find((step) => matcher.test(step.name ?? "") || matcher.test(step.uses ?? ""));
    if (hit) return hit;
  }
  return undefined;
}

function findStepInJobContaining(workflow: Workflow, runMatcher: RegExp, nameMatcher: RegExp): WorkflowStep | undefined {
  for (const job of Object.values(workflow.jobs ?? {})) {
    const steps = job.steps ?? [];
    const ownsRun = steps.some((step) => runMatcher.test(step.run ?? ""));
    if (!ownsRun) continue;
    const hit = steps.find((step) => nameMatcher.test(step.name ?? ""));
    if (hit) return hit;
  }
  return undefined;
}

async function main(): Promise<void> {
  const workflowPath = path.resolve(".github/workflows/release.yml");
  const raw = fs.readFileSync(workflowPath, "utf8");

  let workflow: Workflow;
  try {
    workflow = load(raw) as Workflow;
  } catch (error) {
    throw new Error(`release.yml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  assert.ok(workflow.jobs && Object.keys(workflow.jobs).length > 0, "release.yml must define jobs");

  const matrixArchitectures = Object.values(workflow.jobs ?? {})
    .flatMap((job) => {
      const matrix = job.strategy?.matrix;
      const include = Array.isArray(matrix?.include) ? (matrix?.include as Array<Record<string, unknown>>) : [];
      const direct = Array.isArray(matrix?.architecture) ? (matrix?.architecture as unknown[]) : [];
      const fromInclude = include.map((item) => item.architecture);
      return [...direct, ...fromInclude];
    })
    .filter((value): value is string => typeof value === "string");

  for (const architecture of REQUIRED_ARCHITECTURES) {
    assert.ok(
      matrixArchitectures.includes(architecture),
      `release matrix must include the ${architecture} artifact; found: ${matrixArchitectures.join(", ") || "none"}`,
    );
  }

  const runText = allRunText(workflow);
  assert.match(runText, /stage-release-assets\.ts/, "workflow must stage public/static assets");
  assert.match(runText, /stage-release-artifact\.ts/, "workflow must stage the release artifact");
  assert.match(runText, /inspect-release-artifact\.ts/, "workflow must inspect the release artifact");
  assert.match(runText, /release-manifest\.ts/, "workflow must generate/verify the manifest");
  assert.match(runText, /sha256/i, "workflow must create a SHA-256 checksum");

  // Every architecture the matrix builds must be the runner's REAL
  // architecture. Prisma's query engine is a native binary chosen for the
  // machine that generated the client, so `--architecture arm64` on an x64
  // runner can only stage the x64 engine, and inspection rejects it with
  // "Prisma payload has no native query engine for arm64". A matrix key that
  // is declared and never referenced produces a job that looks configured and
  // cannot succeed: assert the runner selection actually consults it, and that
  // each architecture maps to a runner of the matching arch.
  {
    const jobWithMatrix = Object.entries(workflow.jobs ?? {}).find(([, job]) => {
      const include = job.strategy?.matrix?.include;
      return Array.isArray(include) && include.length > 0;
    });
    assert.ok(jobWithMatrix, "a job must declare a matrix with include entries");
    const [jobName, job] = jobWithMatrix;
    const include = (job.strategy?.matrix?.include as Array<Record<string, unknown>>) ?? [];
    const runsOn = job["runs-on"] ?? "";

    for (const entry of include) {
      const architecture = String(entry.architecture ?? "");
      const runnerArch = String(entry.runner_arch ?? "");
      if (!architecture) continue;
      if (runnerArch) {
        // The declared runner arch must actually be consulted by runs-on,
        // otherwise the key is decorative.
        assert.ok(
          runsOn.includes("runner_arch"),
          `job ${jobName} declares runner_arch for ${architecture} but runs-on ("${runsOn}") never references it, so every cell runs on the same machine and ${architecture} cannot obtain its native engine`,
        );
        // An arm64 cell must not resolve to a runner label that is x64. Test
        // what runs-on actually YIELDS for runner_arch=arm64, not whether the
        // string happens to contain "arm": an expression can mention arm in a
        // dead branch (e.g. `cond && 'ubuntu-latest' || 'ubuntu-latest'`) and
        // still route both cells to the same x64 machine.
        if (runnerArch === "arm64") {
          const chosen = resolveRunsOnFor(runsOn, "arm64");
          assert.ok(
            chosen !== null && /arm/i.test(chosen),
            `job ${jobName} builds ${architecture} on runner_arch=${runnerArch} but runs-on ("${runsOn}") resolves to "${chosen}" for arm64, which is not an arm runner`,
          );
        }
      }
    }
  }

  const stagingStep = findStepInJobContaining(workflow, /stage-release-artifact\.ts/, /stage release artifact/i);
  assert.ok(stagingStep, "a job that stages the artifact must name that step");
  assert.match(stagingStep.run ?? "", /stage-release-artifact\.ts/);
  assert.match(
    stagingStep.run ?? "",
    /--architecture/,
    "staging must be told the artifact architecture so the correct native engine is selected",
  );

  const inspectStep = findStepInJobContaining(workflow, /inspect-release-artifact\.ts/, /inspect/i);
  assert.ok(inspectStep, "release job must have an explicit inspection step");
  assert.ok(
    inspectStep.run && /inspect-release-artifact\.ts/.test(inspectStep.run),
    "inspection step must invoke inspect-release-artifact.ts",
  );
  assert.match(
    inspectStep.run ?? "",
    /--architecture/,
    "inspection must be told the artifact architecture so engine and manifest are validated",
  );

  const checksumStep = findStepInJobContaining(workflow, /sha256/, /checksum/i);
  assert.ok(checksumStep, "release job must have a checksum step");
  assert.match(checksumStep.run ?? "", /release-manifest\.ts sha256/);

  const verifyStep = findStepAnywhere(workflow, /verify/i);
  assert.ok(verifyStep, "release job must verify the checksum before publishing");

  const publishStep = findStepAnywhere(workflow, /action-gh-release/);
  assert.ok(publishStep, "release job must publish a GitHub release");

  const uploadSteps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []).filter((step) =>
    /upload-artifact|action-gh-release/.test(step.uses ?? ""),
  );
  assert.ok(uploadSteps.length > 0, "workflow must upload the inspected artifact");

  for (const step of uploadSteps) {
    const files = typeof step.with?.files === "string" ? (step.with?.files as string) : "";
    if (files) {
      assert.ok(!/static\.tar\.gz/.test(files), "the separate untested static archive must not be published");
    }
  }

  const publishRunsBeforeInspect = Object.entries(workflow.jobs ?? {}).some(([, job]) => {
    const steps = job.steps ?? [];
    const publishIndex = steps.findIndex((step) => /action-gh-release/.test(step.uses ?? ""));
    const inspectIndex = steps.findIndex((step) => /inspect-release-artifact/.test(step.run ?? ""));
    return publishIndex !== -1 && inspectIndex !== -1 && publishIndex < inspectIndex;
  });
  assert.equal(publishRunsBeforeInspect, false, "artifact publication must not run before inspection");

  const tarSteps = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => /tar\s+-[a-z]*c/.test(step.run ?? ""));
  assert.ok(tarSteps.length > 0, "workflow must create the distributable archive");
  for (const step of tarSteps) {
    assert.match(
      step.run ?? "",
      /-C\s+dist\/artifact\s+\./,
      "the archive must be created from the inspected artifact directory, not from a different path",
    );
  }

  // The upload that matters is the ONE CARRYING THE RELEASE ARCHIVE, not the
  // first `upload-artifact` in the file. The browser-gate evidence upload
  // legitimately uses `if-no-files-found: warn` (a runner without a browser
  // should still be able to publish whatever evidence it has), and it appears
  // earlier in the job order — so matching on the action alone picked the
  // evidence step and then failed the very next assertion, which requires a
  // matrix-scoped path. That path only exists on the tarball upload, which is
  // what the test was written to describe all along.
  const archiveUploads = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => /upload-artifact/.test(step.uses ?? ""));
  const uploadStep = archiveUploads.find((step) =>
    /\$\{\{ matrix\.architecture \}\}/.test(String(step.with?.path ?? "")),
  );
  assert.ok(
    uploadStep,
    `workflow must upload the inspected release archive; upload-artifact steps found: ${archiveUploads
      .map((s) => String(s.with?.path ?? "(no path)"))
      .join(" | ")}`,
  );
  assert.equal(
    uploadStep?.with?.["if-no-files-found"],
    "error",
    "artifact upload must fail when the inspected archive is missing",
  );
  assert.match(
    String(uploadStep?.with?.path ?? ""),
    /\$\{\{ matrix\.architecture \}\}/,
    "upload paths must be architecture-scoped so architectures cannot overwrite each other",
  );
  // An evidence upload must never be mistaken for the release archive: it is
  // allowed to be lenient about a missing file, so assert the distinction holds
  // rather than letting it be re-introduced silently.
  for (const step of archiveUploads) {
    if (step === uploadStep) continue;
    assert.equal(
      step.with?.["if-no-files-found"],
      "warn",
      "a non-release upload may warn when its files are absent, but the release archive upload must not",
    );
  }

  const releaseFileStep = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .find((step) => /action-gh-release/.test(step.uses ?? ""));
  const releaseFiles = typeof releaseFileStep?.with?.files === "string" ? String(releaseFileStep?.with?.files) : "";
  assert.match(releaseFiles, /\.tar\.gz\.sha256/, "release assets must include the checksum sidecar");
  assert.doesNotMatch(
    releaseFiles,
    /static\.tar\.gz/,
    "the separate untested static archive must not be published",
  );

  const verifyBeforePublish = Object.values(workflow.jobs ?? {}).some((job) => {
    const steps = job.steps ?? [];
    const verifyIndex = steps.findIndex((step) => /release-manifest\.ts verify/.test(step.run ?? ""));
    const publishIndex = steps.findIndex((step) => /action-gh-release/.test(step.uses ?? ""));
    return verifyIndex !== -1 && publishIndex !== -1 && verifyIndex < publishIndex;
  });
  assert.equal(verifyBeforePublish, true, "checksums must be re-verified in the publishing job before release creation");

  const publishJob = Object.entries(workflow.jobs ?? {}).find(([, job]) =>
    (job.steps ?? []).some((step) => /action-gh-release/.test(step.uses ?? "")),
  );
  assert.ok(publishJob, "publish job must exist");
  const needs = publishJob?.[1].needs;
  const needsList = Array.isArray(needs) ? needs : needs ? [needs] : [];
  assert.ok(needsList.includes("artifact"), "publishing must depend on the architecture matrix job");

  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    const permissions = job.permissions ?? workflow.permissions;
    assert.ok(permissions, `job ${name} must declare explicit permissions`);
  }


  console.log("✅ Release workflow: architecture matrix, staging, inspection, manifest, checksum, and publish order verified");
  testCiVerdictRunsAgainstAStagedPayload();

  /*
   * Found the hard way: release run 37254378970 built the artifact, then ran the
   * browser gate (`npx playwright install --with-deps chromium`, ~1.5GB), and
   * only THEN tried to tar the artifact. The runner was out of disk and tar died
   * with "Cannot write: Broke" / "Error is not recoverable" on both
   * architectures -- no disk error anywhere in the log, because tar does not say
   * ENOSPC. ci.yml already archives first; release.yml had the two steps in the
   * opposite order, so this had never been exercised on a full release run.
   */
  function testArchivePrecedesTheDiskHeavyBrowserGate(): void {
    const artifactJob = (workflow as { jobs?: Record<string, { steps?: WorkflowStep[] }> })
      .jobs?.artifact;
    assert.ok(artifactJob, "the workflow must have an artifact job");
    const names: string[] = (artifactJob.steps ?? []).map((s: WorkflowStep) => String(s.name ?? ""));

    const archive = names.findIndex((n) => /create archive/i.test(n));
    const browser = names.findIndex((n) => /browser gate/i.test(n));

    assert.ok(archive >= 0, "the artifact job must create an archive");
    assert.ok(browser >= 0, "the artifact job must run a browser gate");

    assert.ok(
      archive < browser,
      `the archive must be created before the browser gate (archive step ${archive + 1}, browser gate step ${browser + 1}); ` +
        "playwright install --with-deps pulls ~1.5GB and tar then fails with ENOSPC reported as 'Cannot write: Broke'",
    );

    // A guard must exist so the failure names disk space rather than surfacing
    // three steps later inside tar.
    const hasDiskGuard = (artifactJob.steps ?? []).some((s: WorkflowStep) =>
      /(reclaim|free space|df -k)/i.test(String(s.run ?? "")),
    );
    assert.ok(
      hasDiskGuard,
      "no disk-space check before the browser gate; an exhausted runner fails as 'Cannot write: Broke'",
    );

    console.log("\u2705 Release workflow: the archive is created before the disk-heavy browser gate");
  }

  function testTagPushUsesAValidRefspec(): void {
    const versionJob = workflow.jobs?.version;
    assert.ok(versionJob, "the workflow must have a version job");
    const steps: WorkflowStep[] = versionJob.steps ?? [];
    const pushStep = steps.find((s: WorkflowStep) =>
      (s.run ?? "")
        .split("\n")
        .some((l) => /git push\s+origin\s+"[^"]*(?:tag)/.test(l)),
    );
    assert.ok(pushStep, "a step must push the release tag");

    const run: string = pushStep.run ?? "";
    const tagPushes = run
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^git push\s+origin\s+"[^"]*tag/.test(l));

    assert.ok(tagPushes.length > 0, "the push step must actually push a tag");

    for (const line of tagPushes) {
      // Extract the quoted refspec argument.
      const m = line.match(/git push origin "([^"]+)"/);
      assert.ok(m, `tag push must quote a refspec, got: ${line}`);
      const refspec = m![1]!;
      // A tag refspec is refs/tags/<name>. The bare phrase "tag v1.2.1" (as this
      // workflow once had) is not a refspec at all and git rejects it -- but
      // only AFTER the version-bump commit has already been pushed to master.
      assert.match(
        refspec,
        /^refs\/tags\//,
        `tag push must use a refs/tags/... refspec; git rejects "${refspec}" as an invalid refspec`,
      );
    }

    console.log("\u2705 Release workflow: the tag push uses a valid git refspec");
  }
  testTagPushUsesAValidRefspec();
  testArchivePrecedesTheDiskHeavyBrowserGate();
}

/**
 * ci.yml, not release.yml: the `verify` job runs the 50-suite aggregate, and
 * two of those suites need the STAGED PAYLOAD. `verify` runs on ubuntu-latest,
 * where the runner takes its local (non-WSL) path, so the payload must be built
 * and staged IN THAT JOB.
 *
 * This was a live defect, not a hypothetical: `verify` had no build, so the
 * aggregate exited 1 on every runner with "cp: cannot stat .../dist/artifact"
 * and 0/1 suites passed. Asserting the ORDER is what stops it coming back,
 * because a present-but-misordered step is just as broken as a missing one.
 */
  /*
   * Found the hard way: a release run pushed the version-bump commit and then
   * died on `git push origin "tag v1.2.1"`. That is not a refspec -- git
   * rejects it with "fatal: invalid refspec 'tag v1.2.1'". The bump commit had
   * already landed on master, so the repo was left at 1.2.1 with no tag and no
   * release. Nothing asserted the workflow's push commands were valid git, so
   * the publish path stayed untested until a real release needed it.
   */
function testCiVerdictRunsAgainstAStagedPayload(): void {
  const ciPath = path.join(repoRoot, ".github", "workflows", "ci.yml");
  const ci = load(fs.readFileSync(ciPath, "utf8")) as Workflow;
  const verifyJob = ci.jobs?.verify;
  assert.ok(verifyJob, "ci.yml must have a verify job");
  const runs = (verifyJob.steps ?? []).map((step) => step.run ?? "");

  const idxOf = (re: RegExp): number => runs.findIndex((run) => re.test(run));
  const buildIdx = idxOf(/npm run build\b/);
  const stageIdx = idxOf(/stage-release-artifact\.ts/);
  const suiteIdx = idxOf(/run-all-tests\.ts/);

  assert.ok(buildIdx >= 0, "verify must build before running the suites");
  assert.ok(stageIdx >= 0, "verify must stage the release artifact before running the suites");
  assert.ok(suiteIdx >= 0, "verify must run the full local suite list");
  assert.ok(
    stageIdx < suiteIdx,
    `the staged payload must exist before the suite runs (stage at ${stageIdx}, suite at ${suiteIdx})`,
  );

  // The two payload suites must not be silently dropped to make the job green.
  const runner = fs.readFileSync(path.join(repoRoot, "scripts", "run-all-tests.ts"), "utf8");
  for (const suite of ["test-protected-routes.ts", "test-lowram-cgroup-gate.sh"]) {
    assert.ok(runner.includes(suite), `${suite} must stay registered in run-all-tests.ts`);
  }
  assert.ok(
    /FATAL: these suites need the staged release payload/.test(runner),
    "run-all-tests.ts must preflight the payload and name the build/stage commands",
  );

  console.log("\u2705 CI workflow: verify builds and stages the payload before the suite, and the runner preflights it");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
