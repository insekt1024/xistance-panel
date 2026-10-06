/**
 * TASK-103. The docker job must not publish a single-arch image under a tag that
 * claims a multi-architecture release.
 *
 * The `artifact` job publishes `amd64` AND `arm64` archives. The `docker` job
 * runs on `ubuntu-latest` (x64) and calls `docker/build-push-action` with no
 * `platforms:` list, which builds for the RUNNER's architecture only. It then
 * tags the result with the release semver and with `latest`.
 *
 * So `ghcr.io/...:1.2.0` and `:latest` are amd64-only images advertised for a
 * release that ships two architectures. An arm64 host pulling the tag gets no
 * matching image, and the job goes green while publishing something narrower
 * than the release.
 *
 * This asserts the image is either explicitly multi-arch, or that the
 * single-arch intent is impossible to miss. Right now it is neither, which is
 * the defect.
 *
 * Non-vacuity: the platform assertion is re-checked against a copy of the
 * workflow with the `platforms:` key removed, and must report the difference.
 */
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const WORKFLOW = path.join(REPO, ".github", "workflows", "release.yml");

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

const src = fs.readFileSync(WORKFLOW, "utf8");

// Isolate the docker job so assertions cannot accidentally match the artifact job.
const dockerAt = src.indexOf("  docker:");
if (dockerAt < 0) {
  check("the workflow still has a docker job", false);
  console.log(`\n--- ${pass} passed, ${fail} failed ---`);
  process.exit(1);
}
const job = src.slice(dockerAt);

// The release publishes two architectures. The image must cover both, or the
// workflow must not claim the release's tag at all.
const MULTI_ARCH = /(linux\/amd64.*linux\/arm64|linux\/arm64.*linux\/amd64)/s;
check(
  "the docker image is built for BOTH architectures the release ships",
  MULTI_ARCH.test(job),
  [
    "docker/build-push-action has no `platforms:` list, so it builds for the",
    "runner's architecture only (ubuntu-latest = x64). The image is tagged with",
    "the release semver and with `latest`, so both claim an amd64-only image.",
    "Fix: add `platforms: linux/amd64,linux/arm64` to the build step.",
  ].join("\n"),
);

check(
  "the docker build step declares platforms (or the omission is deliberate)",
  job.includes("platforms:") || job.includes("platforms :"),
  "no `platforms:` key anywhere in the docker job",
);

// The artifact job really does ship two architectures, so the image claim is not
// vacuous -- there IS something to cover.
const artifactJob = src.slice(src.indexOf("  artifact:"), dockerAt);
check(
  "the release really does publish two architectures (so the claim is not vacuous)",
  /architecture:\s*amd64/.test(artifactJob) && /architecture:\s*arm64/.test(artifactJob),
  "the artifact matrix no longer declares both architectures",
);

// The `latest` tag is the one that persists after a release is superseded, so a
// single-arch latest is the durable version of this problem.
check(
  "the image is tagged `latest` (which is what makes a single-arch image durable)",
  job.includes("value=latest"),
  "no latest tag found; re-check whether this finding still applies",
);

// ---------------------------------------------------------------------------
// Non-vacuity. Remove the platforms key from an in-memory copy and confirm the
// assertion distinguishes the two shapes.
// ---------------------------------------------------------------------------
{
  // Strip EVERY `platforms:` line, not just the first. The docker job now also
  // carries `platforms: arm64` on its docker/setup-qemu-action step (needed, or
  // the multi-platform build fails with "Multi-platform build is not supported
  // for the docker driver"). With a single non-global replace the mutation
  // removed the QEMU line instead of the build step's, so the stripped copy
  // STILL matched the multi-arch pattern and this control stopped biting --
  // failing on run 37514215168 as "the stripped copy still matched".
  const stripped = job.replace(/^\s*platforms:.*$/gm, "");
  const hadPlatforms = stripped !== job;
  check(
    "the mutant differs from the original (a platforms key existed to remove)",
    hadPlatforms || !MULTI_ARCH.test(job),
    "the workflow has no platforms key to remove, so this control cannot bite",
  );
  if (hadPlatforms) {
    check(
      "dropping `platforms:` is detected by the assertion",
      !MULTI_ARCH.test(stripped),
      "the stripped copy still matched the multi-arch pattern",
    );
  }
}

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
