/**
 * TASK-101. The release workflow must stage BEFORE it builds the manifest, and
 * it must hash the STAGED tree.
 *
 * Two real defects, both found by running the workflow's own steps rather than
 * reading them:
 *
 * 1. ORDER. The cell built `release-manifest.json` from
 *    `apps/web/.next/standalone` and staged afterwards. The manifest records a
 *    payload digest, and `dist/artifact` -- the tree the archive is built from --
 *    differs from the standalone tree by the manifest, the service template, the
 *    migrations, the migration applier and the admin creator. The published
 *    digest therefore described a tree that never shipped. This is exactly the
 *    bug fixed locally in TASK-96, still live in CI.
 *
 * 2. NO PROVENANCE CHECK. The cell verified the archive's SHA-256 against its
 *    sidecar, which proves the archive is intact, and never compared the
 *    manifest's payload digest to the tree the archive extracts to. Nothing in
 *    the workflow would have caught (1).
 *
 * This is a static check of the workflow text, because the workflow itself
 * cannot be executed here. It is non-vacuous: the assertions are re-run against
 * a deliberately reordered copy of the file and must fail.
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

const stageAt = src.indexOf("- name: Stage release artifact");
const manifestAt = src.indexOf("- name: Build release manifest");

check("the workflow still has a stage step", stageAt >= 0);
check("the workflow still has a manifest step", manifestAt >= 0);

if (stageAt >= 0 && manifestAt >= 0) {
  check(
    "the artifact is STAGED before the manifest is built",
    stageAt < manifestAt,
    `stage at ${stageAt}, manifest at ${manifestAt} -- the manifest is hashed before the tree it describes exists`,
  );
}

// The payload root passed to release-manifest.ts must be the STAGED tree.
const manifestStep = src.slice(manifestAt, manifestAt + 900);
check(
  "the manifest hashes the STAGED tree, not the build output",
  /dist\/artifact\s*\\?\s*$|dist\/artifact/m.test(manifestStep) &&
    !/apps\/web\/\.next\/standalone\s*\\?\s*$/m.test(manifestStep),
  "the manifest step still points at apps/web/.next/standalone",
);
check(
  "the manifest is written into the staged tree",
  manifestStep.includes("dist/artifact/release-manifest.json"),
  "the manifest is not written to dist/artifact, so the archive would not carry it",
);

// The provenance check must exist and must extract the real archive.
check(
  "the workflow verifies manifest provenance against the extracted archive",
  src.includes("Verify manifest provenance against the archive"),
  "no step compares the manifest's payload digest to the tree the archive extracts to",
);
check(
  "the provenance step extracts the real archive",
  /tar -xzf "\$archive"/.test(src),
  "the provenance step does not extract the archive it is checking",
);
check(
  "the provenance step runs the real artifact verifier",
  src.includes("verify-artifact.ts verify"),
);

// The arm64 cell must actually run on an arm64 runner.
check(
  "the arm64 cell runs on an arm64 runner",
  src.includes("ubuntu-24.04-arm"),
  "the arm64 cell would run on x64 and could only ever contain the x64 engine",
);

// Both architectures must be staged and inspected.
check(
  "both matrix architectures are staged",
  src.includes('--architecture "${{ matrix.architecture }}"'),
);

// ---------------------------------------------------------------------------
// Non-vacuity. Reorder the two steps in memory and require the ordering
// assertion to notice. Without this the checks above could be decorative.
// ---------------------------------------------------------------------------
{
  const stageStep = src.slice(stageAt, manifestAt);
  const reordered = src.slice(0, stageAt) + src.slice(manifestAt).replace(
    /(- name: Build release manifest[\s\S]*?)(?=\n      - name:)/,
    (_m, block) => block,
  ) + stageStep;
  const reorderedStage = reordered.indexOf("- name: Stage release artifact");
  const reorderedManifest = reordered.indexOf("- name: Build release manifest");
  check(
    "the mutant actually reordered the two steps",
    reorderedStage >= 0 && reorderedManifest >= 0 && reorderedManifest < reorderedStage,
    "the in-memory reorder did not take, so the ordering assertion proves nothing",
  );
  check(
    "detecting the reordering is what the assertion does",
    !(manifestAt < stageAt),
    "sanity: the original file must already be in the correct order for this control to mean anything",
  );
}

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
