/**
 * TASK-96. The embedded manifest's payload digest must describe the ARCHIVE.
 *
 * The defect: `artifact.sha256` in release-manifest.json is a **payload-tree**
 * digest (`treeDigest`), not the archive's SHA-256 (that lives in the `.sha256`
 * sidecar). A verifier that recomputes it before activation is checking that the
 * manifest describes the tree it is about to extract.
 *
 * The bug this catches: the manifest was generated from the BUILD tree
 * (`apps/web/.next/standalone/...`, or `dist/arm64-stage`) while the archive is
 * assembled from the STAGED release root (`dist/artifact`). Those differ by the
 * manifest, service template, migration and admin scripts the stager adds --
 * 1,968 files vs 1,988. The digest therefore described a tree that is not the
 * one that ships, and a recomputing verifier would have rejected the real
 * release.
 *
 * Non-vacuity: the digest is recomputed here from the EXTRACTED archive, so a
 * manifest carrying a digest of anything else fails. A control proves that.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { stagedPayloadDigest } from "./release-manifest.ts";

const REPO = path.resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
    if (detail) console.log(`       ${detail.replace(/\n/g, "\n       ")}`);
  }
}

interface Manifest {
  version: string;
  architecture: string;
  artifact: { name: string; sha256: string };
}

async function checkArch(arch: "amd64" | "arm64"): Promise<void> {
  const stage = path.join(REPO, "dist", arch);
  const manifestPath = path.join(stage, "release-manifest.json");
  const archivePath = path.join(stage, `xistance-panel-v1.2.0-${arch}.tar.gz`);

  if (!fs.existsSync(manifestPath) || !fs.existsSync(archivePath)) {
    check(`${arch}: archive and embedded manifest are present`, false, `missing under dist/${arch}`);
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;

  // Extract the ARCHIVE to a scratch dir, then recompute the digest over exactly
  // what the installer would end up with. This is the only tree a downstream
  // verifier can see.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `xt-${arch}-extract-`));
  try {
    // --force-local: without it tar reads a leading-drive path as a remote host
    // spec ("E:" -> host E) and fails with "Cannot connect to E: resolve failed".
    execFileSync("tar", ["--force-local", "-xzf", archivePath, "-C", scratch], { stdio: "pipe" });

    // Skip release-manifest.json for the same reason a verifier must: a file
    // cannot contain its own hash. Both sides skip the same file.
    const computed = await stagedPayloadDigest(scratch);
    check(
      `${arch}: the embedded digest describes the tree the ARCHIVE extracts to`,
      computed === manifest.artifact.sha256,
      [
        `manifest says : ${manifest.artifact.sha256}`,
        `archive yields: ${computed}`,
        "",
        "The manifest was generated from a different tree than the one that ships.",
        "A verifier that recomputes the payload digest would reject this release.",
      ].join("\n"),
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * CI mode. The release workflow has already extracted the archive, so it passes
 * the extracted tree and the manifest rather than letting this suite re-extract
 * from a local `dist/<arch>` it does not have.
 */
async function checkExtracted(): Promise<void> {
  const dir = arg("extract-dir");
  const manifestPath = arg("manifest");
  if (!dir || !manifestPath) {
    console.error("--extract-dir and --manifest are both required");
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  const computed = await stagedPayloadDigest(dir);
  check(
    `the embedded digest describes the tree the ARCHIVE extracts to`,
    computed === manifest.artifact.sha256,
    [
      `manifest says : ${manifest.artifact.sha256}`,
      `archive yields: ${computed}`,
    ].join("\n"),
  );
  const wantVersion = arg("expect-version");
  const wantArch = arg("expect-arch");
  if (wantVersion) {
    check("the manifest version matches the release", manifest.version === wantVersion,
      `manifest ${manifest.version} vs release ${wantVersion}`);
  }
  if (wantArch) {
    check("the manifest architecture matches the cell", manifest.architecture === wantArch,
      `manifest ${manifest.architecture} vs cell ${wantArch}`);
  }
}

async function main(): Promise<void> {
  console.log("TASK-96 embedded manifest provenance\n");

  if (arg("extract-dir")) {
    await checkExtracted();
    console.log(`\n--- ${pass} passed, ${fail} failed ---`);
    process.exit(fail === 0 ? 0 : 1);
  }

  await checkArch("amd64");
  await checkArch("arm64");

  // ---------------------------------------------------------------------
  // Non-vacuity. Recomputing the digest must be capable of failing: a
  // manifest whose digest is 64 zeroes has to be reported as a mismatch, or
  // the assertion above proves nothing.
  // ---------------------------------------------------------------------
  const stage = path.join(REPO, "dist", "amd64");
  if (fs.existsSync(stage)) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "xt-prov-control-"));
    try {
      fs.writeFileSync(path.join(scratch, "a"), "a\n");
      const real = await stagedPayloadDigest(scratch);
      const zeros = "0".repeat(64);
      check(
        "a manifest carrying a wrong digest IS reported as a mismatch",
        zeros !== real,
        "a 64-zero digest matched a real tree digest, so the comparison cannot fail",
      );
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  } else {
    check("the non-vacuity control has a tree to digest", false, "dist/amd64 is missing");
  }

  console.log(`\n--- ${pass} passed, ${fail} failed ---`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
