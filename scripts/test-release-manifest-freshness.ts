/**
 * The ROOT release manifest must describe a payload tree that still exists.
 *
 * THE DEFECT THIS CAUGHT
 * ---------------------
 * `release-manifest.json` carried `artifact.sha256 = 044c1b8f3ae0bc9b...`, and
 * that value matches **neither** tree it could plausibly describe:
 *
 *     apps/web/.next/standalone/apps/web   b70db5e3b8a789e7...   (836 files)
 *     dist/artifact                       5c5e630c807db105...   (1988 files)
 *     release-manifest.json claims        044c1b8f3ae0bc9b...
 *
 * So the manifest described a payload that no longer exists on disk. A verifier
 * that recomputes the digest before extraction -- which is the entire point of
 * recording a *payload* digest instead of the archive's -- would reject the
 * release. The metadata was authoritative-looking and unfalsifiable.
 *
 * WHY IT IS A PAYLOAD DIGEST, NOT THE ARCHIVE'S
 * ----------------------------------------------
 * This is deliberate, and worth stating because it is easy to "fix" wrongly.
 * `treeDigest` is documented as the digest "which must be computable without
 * archiving (an archive cannot contain its own digest)". A verifier recomputes
 * it from the extracted tree, so it proves the bytes on the target match what
 * was built. Comparing the manifest to the `.tar.gz` would be meaningless, and
 * earlier notes recorded exactly that trap.
 *
 * So this suite does NOT compare the manifest against the archive. It compares
 * it against the tree it names, and when it cannot, it says so.
 *
 * WHY NOTHING ELSE CAUGHT IT
 * --------------------------
 *   1. The `.sha256` sidecar verified OK -- it is compared to the archive, and
 *      the archive is correct. Nothing compared either to the manifest.
 *   2. `test-verify-artifact.ts` builds its fixtures with `buildReleaseManifest`,
 *      so manifest and digest are produced together and agree by construction.
 *      It proves the verifier's logic, never that the repo's manifest is current.
 *   3. `buildReleaseManifest` takes the digest as an INPUT. Regenerating the
 *      manifest after changing a file produces a new value only if the caller
 *      remembers to recompute the tree; otherwise it silently keeps a stale one.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { REPO } from "./lib/browser-harness";
import { inspectReleaseManifest, stagedPayloadDigest, treeDigest } from "./release-manifest.ts";

let pass = 0;
let fail = 0;
let skip = 0;

function ok(name: string, detail = ""): void {
  pass += 1;
  console.log(`  ok   ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function bad(name: string, detail = ""): void {
  fail += 1;
  console.log(`  FAIL ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function countFiles(root: string): number {
  let n = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) n += 1;
    }
  };
  if (fs.existsSync(root)) walk(root);
  return n;
}

/**
 * The trees a release manifest's payload digest can describe.
 *
 * `artifact.sha256` is a digest of the STAGED release root with
 * `release-manifest.json` excluded -- `stagedPayloadDigest`, not `treeDigest`
 * (TASK-96). It used to be hashed over `apps/web/.next/standalone/apps/web`, a
 * subdirectory of the build output that the archive does not correspond to.
 *
 * The staged root is therefore not merely the best candidate, it is the ONLY
 * correct one. `.next/standalone` stays in the list for reporting: showing what
 * the build tree hashes to is how a mismatch becomes diagnosable rather than
 * just red.
 */
const STAGED_ROOTS = ["dist/artifact", "dist/artifact-arm64"];
const REPORT_ONLY_ROOTS = ["apps/web/.next/standalone", "apps/web/.next/standalone/apps/web"];

async function main(): Promise<void> {
  console.log("=== the root release manifest describes a real payload ===\n");

  const manifestPath = path.join(REPO, "release-manifest.json");

  // A missing manifest before CI publishes an artifact is legitimate.
  if (!fs.existsSync(manifestPath)) {
    skip += 1;
    console.log("  SKIP no root release-manifest.json (normal before CI publishes)");
    console.log("\n--- 0 passed, 0 failed, 1 skipped ---");
    process.exit(0);
  }

  const raw = fs.readFileSync(manifestPath, "utf8");
  const inspection = inspectReleaseManifest(raw);

  if (!inspection.ok) {
    bad("the root manifest is well formed", inspection.errors.join("; "));
    console.log("\n--- 0 passed, 1 failed ---");
    process.exit(1);
  }
  ok("the root manifest is well formed");

  const manifest = JSON.parse(raw) as {
    version: string;
    architecture: string;
    artifact: { name: string; sha256: string };
  };
  const claimed = manifest.artifact.sha256;

  // Recompute every candidate tree and look for a match. The staged roots use
  // `stagedPayloadDigest` (excludes the manifest); the build trees use plain
  // `treeDigest` because they are only reported, never expected to match.
  const digests: { root: string; files: number; digest: string | null }[] = [];
  for (const rel of STAGED_ROOTS) {
    const abs = path.join(REPO, rel);
    let digest: string | null = null;
    try {
      digest = await stagedPayloadDigest(abs);
    } catch {
      digest = null; // tree absent or unreadable
    }
    digests.push({ root: rel, files: countFiles(abs), digest });
  }
  for (const rel of REPORT_ONLY_ROOTS) {
    const abs = path.join(REPO, rel);
    let digest: string | null = null;
    try {
      digest = await treeDigest(abs);
    } catch {
      digest = null;
    }
    digests.push({ root: rel, files: countFiles(abs), digest });
  }

  console.log(`  manifest claims: ${claimed.slice(0, 16)}... (${manifest.architecture})`);
  for (const d of digests) {
    const shown = d.digest ? d.digest.slice(0, 16) + "..." : "unavailable";
    console.log(`  ${d.root.padEnd(38)} ${shown}  (${d.files} files)`);
  }
  console.log();

  const match = digests.find((d) => d.digest === claimed);
  if (match) {
    ok("the manifest digest matches a payload tree on disk",
      `${match.root} (${match.files} files)`);
  } else {
    const available = digests.filter((d) => d.digest !== null);
    if (available.length === 0) {
      skip += 1;
      console.log("  SKIP no payload tree exists to recompute the digest from");
      console.log("       (normal before a build; CI regenerates the manifest)");
    } else {
      bad("the manifest digest matches a payload tree on disk",
        "it matches none of the trees the release scripts stage from");
      bad("",
        "a verifier that recomputes this digest before extraction would reject the release");
    }
  }

  // The archive and its sidecar are the other half of the pair. They are
  // checked here so the whole release is described in one place.
  const archivePath = path.join(REPO, "dist", manifest.architecture, manifest.artifact.name);
  if (fs.existsSync(archivePath)) {
    const actual = createHash("sha256").update(fs.readFileSync(archivePath)).digest("hex");
    ok("the built archive exists for this manifest",
      `${path.relative(REPO, archivePath)} (${fs.statSync(archivePath).size} bytes)`);

    const sidecarPath = `${archivePath}.sha256`;
    if (fs.existsSync(sidecarPath)) {
      const sidecar = fs.readFileSync(sidecarPath, "utf8").trim().split(/\s+/)[0];
      if (sidecar === actual) ok("the .sha256 sidecar matches the archive", sidecar.slice(0, 16) + "...");
      else bad("the .sha256 sidecar matches the archive",
        `sidecar ${sidecar.slice(0, 16)}... vs archive ${actual.slice(0, 16)}...`);
    } else {
      bad("the .sha256 sidecar exists next to the archive", sidecarPath);
    }
  } else {
    skip += 1;
    console.log(`  SKIP no built archive at ${path.relative(REPO, archivePath)}`);
  }

  console.log(`\n--- ${pass} passed, ${fail} failed, ${skip} skipped ---`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
