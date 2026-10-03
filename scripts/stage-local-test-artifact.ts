/**
 * Stage an artifact for LOCAL testing on this host, keeping the release one
 * intact.
 *
 * The release artifact is single-architecture by design: `stageReleaseArtifact`
 * strips every Prisma engine except the one for its target. That is correct for
 * a release and it means a Windows development machine cannot boot the
 * artifact, so an asset smoke suite written against it can only ever exit 77
 * here and prove nothing.
 *
 * This stages a SECOND copy from the same build with every engine retained, into
 * dist/artifact-local. It is a test fixture, not a release candidate:
 *
 *   - `dist/artifact` is untouched, so the single-architecture guarantee is
 *     still what the release path produces and what other suites check.
 *   - The payload is byte-identical apart from the extra engine files, so an
 *     asset that is missing or mis-typed here is missing on the target too.
 *   - The extra engine is the ONLY difference, and it is named in the output so
 *     nobody mistakes this for a releasable tree.
 *
 * Anything this suite proves about assets, localization and content types is
 * therefore a real result on this host. What it cannot prove is Linux-specific
 * behaviour, which still needs the VPS run.
 *
 * Run: npx tsx scripts/stage-local-test-artifact.ts
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** A dependency's installed version, or a loud failure rather than a guess. */
function dependencyVersion(repoRoot: string, name: string): string {
  const manifest = path.join(repoRoot, "node_modules", ...name.split("/"), "package.json");
  if (!fs.existsSync(manifest)) {
    throw new Error(`cannot resolve ${name} at ${manifest}; run npm install before staging`);
  }
  const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: string };
  return typeof parsed.version === "string" ? parsed.version : "unknown";
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..");
  const destination = path.join(repoRoot, "dist", "artifact-local");

  // Build inputs first, exactly as the release path does.
  const { stageReleaseAssets } = await import("./stage-release-assets.ts");
  await stageReleaseAssets(repoRoot);

  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version?: string };
  const version = typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : "0.0.0";
  const { buildReleaseManifest, inspectReleaseManifest, treeDigest } = await import("./release-manifest.ts");

  const manifestRaw = buildReleaseManifest({
    version,
    commit,
    architecture: "amd64",
    artifactName: `xistance-panel-${version}-amd64.tar.gz`,
    artifactSha256: await treeDigest(path.join(repoRoot, "apps", "web", ".next", "standalone", "apps", "web")),
    runtime: {
      node: process.versions.node,
      next: dependencyVersion(repoRoot, "next"),
      prisma: dependencyVersion(repoRoot, "@prisma/client"),
    },
  });
  const inspection = inspectReleaseManifest(manifestRaw);
  if (!inspection.ok) {
    console.error("the generated manifest is not self-consistent:");
    for (const error of inspection.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  const manifestPath = path.join(repoRoot, "release-manifest.json");
  fs.writeFileSync(manifestPath, manifestRaw, "utf8");

  const { stageReleaseArtifact } = await import("./stage-release-artifact.ts");
  fs.rmSync(destination, { recursive: true, force: true });
  // Staged exactly as a release is: single-architecture, amd64, no Windows engine.
  await stageReleaseArtifact({ repoRoot, destination, architecture: "amd64" });

  // Then add the host's own engine, on purpose, AFTER the release filter ran.
  // There is no way to ask the stager for this: `ReleaseArchitecture` is
  // "amd64" | "arm64" and `inspectReleaseArtifact` treats a Windows engine in a
  // payload as a defect, which is right for a release and exactly what has to
  // be undone for a local run. So it is copied in here rather than smuggled in
  // through an option, and the fact that this bypasses the filter is why the
  // output says TEST FIXTURE and why dist/artifact is left alone.
  const clientDir = path.join(destination, "packages", "db", "generated", "client");
  const hostEngine = process.platform === "win32" ? "query_engine-windows.dll.node" : null;
  if (hostEngine === null) {
    console.log("this host already matches the release architecture; no extra engine needed");
  } else {
    const source = path.join(repoRoot, "packages", "db", "generated", "client", hostEngine);
    if (!fs.existsSync(source)) {
      throw new Error(
        `no ${hostEngine} in packages/db/generated/client. Run \`npx prisma generate\` in packages/db ` +
          `before staging, otherwise this host cannot boot the artifact at all.`,
      );
    }
    fs.copyFileSync(source, path.join(clientDir, hostEngine));
  }

  const engines = fs.readdirSync(clientDir).filter((e) => e.endsWith(".node"));
  console.log(`staged LOCAL TEST fixture -> ${destination}`);
  console.log(`  Prisma engines present: ${engines.join(", ")}`);
  console.log("  NOTE: test fixture only -- the extra host engine bypasses the release");
  console.log("        architecture filter. dist/artifact is untouched and still ships");
  console.log("        the single-architecture amd64 payload.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
