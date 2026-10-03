/**
 * Stage the REAL repository into dist/artifact for the runtime smoke suites.
 *
 * `stage-release-artifact.ts` is a library with a thin CLI wrapper, and the
 * wrapper's argument order is easy to get wrong from a shell. Calling the
 * exported function directly removes the ambiguity.
 *
 * Run: npx tsx scripts/stage-real-artifact.ts
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** A dependency's installed version, or a loud failure rather than a guess. */
function dependencyVersion(name: string): string {
  const manifest = path.join(__dirname, "..", "node_modules", ...name.split("/"), "package.json");
  if (!fs.existsSync(manifest)) {
    throw new Error(
      `cannot resolve ${name} at ${manifest}. The release manifest must state the runtime it ships; ` +
      `run npm install before staging.`,
    );
  }
  const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: string };
  return typeof parsed.version === "string" ? parsed.version : "unknown";
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, "..");
  const destination = path.join(repoRoot, "dist", "artifact");

  // Order matters. `stageReleaseAssets` copies public/ and .next/static INTO the
  // standalone tree; `stageReleaseArtifact` then refuses to run unless they are
  // already there, because its whole job is to copy that tree and add the
  // manifest, migrations and admin script. Running them the other way round
  // fails with "standalone static chunks is missing", which reads like a broken
  // build rather than a missing step.
  const { stageReleaseAssets } = await import("./stage-release-assets.ts");
  await stageReleaseAssets(repoRoot);

  // ---- build the manifest from the staged tree ---------------------------
  // Real inputs only: the checked-out HEAD and the version from package.json.
  // Neither is invented, because a manifest naming a commit that does not exist
  // is worse than no manifest at all -- and the staging step below refuses to
  // run without one, so a fabricated value would silently become release
  // metadata.
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { version?: string };
  const version = typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : "0.0.0";
  const { buildReleaseManifest, inspectReleaseManifest, stagedPayloadDigest } = await import("./release-manifest.ts");

  // The name must match what release.yml produces:
  //   ARTIFACT_NAME: xistance-panel-v<version>-<arch>.tar.gz
  // A local staging manifest that omits the "v" describes a file the release
  // never publishes, so the local manifest and the published artifact disagree
  // on the one string a downloader types. Verified against release.yml rather
  // than assumed, because the two are edited independently.
  const artifactName = `xistance-panel-v${version}-amd64.tar.gz`;

  const manifestPath = path.join(repoRoot, "release-manifest.json");
  const { stageReleaseArtifact } = await import("./stage-release-artifact.ts");

  // Two-pass staging. The manifest records the digest of the tree it ships
  // inside, so it can only be built once that tree exists -- but the tree only
  // contains the manifest because staging copies it in. Pass 1 stages a
  // placeholder so the tree is complete; the digest is then taken over that
  // complete tree (skipping the manifest, which cannot contain its own hash),
  // and pass 2 re-stages with the real manifest.
  // A structurally VALID manifest whose digest is a placeholder. It must be a
  // real manifest, not `{}`: stageReleaseArtifact inspects the tree it stages and
  // rejects a manifest that is missing required fields. Only the digest value is
  // provisional, and the digest skips the manifest file anyway, so pass 1 and
  // pass 2 produce the same payload digest.
  const PLACEHOLDER = buildReleaseManifest({
    version,
    commit,
    architecture: "amd64",
    artifactName,
    artifactSha256: "0".repeat(64),
    runtime: {
      node: process.versions.node,
      next: dependencyVersion("next"),
      prisma: dependencyVersion("@prisma/client"),
    },
  });
  fs.writeFileSync(manifestPath, PLACEHOLDER, "utf8");
  fs.rmSync(destination, { recursive: true, force: true });
  await stageReleaseArtifact({ repoRoot, destination, architecture: "amd64" });

  const artifactSha256 = await stagedPayloadDigest(destination);
  const manifestRaw = buildReleaseManifest({
    version,
    commit,
    architecture: "amd64",
    artifactName,
    // The archive is produced from the STAGED tree (`destination`), so the digest
    // is taken there -- not from a subdirectory of the build output, which is
    // what this used to hash and which describes a tree that never ships.
    artifactSha256,
    // Read the runtime versions from the installed tree rather than pinning
    // literals: a manifest that claims a Next or Prisma version the artifact
    // does not contain is exactly the kind of metadata a verifier cannot trust.
    runtime: {
      node: process.versions.node,
      next: dependencyVersion("next"),
      prisma: dependencyVersion("@prisma/client"),
    },
  });
  const inspection = inspectReleaseManifest(manifestRaw);
  if (!inspection.ok) {
    console.error("the generated manifest is not self-consistent:");
    for (const error of inspection.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  console.log(`payload digest over ${destination} = ${artifactSha256}`);

  // Pass 2: re-stage with the real manifest in place.
  fs.writeFileSync(manifestPath, manifestRaw, "utf8");
  console.log(`wrote ${path.relative(repoRoot, manifestPath)} for ${version} (${commit.slice(0, 12)})`);
  fs.rmSync(destination, { recursive: true, force: true });
  await stageReleaseArtifact({ repoRoot, destination, architecture: "amd64" });

  const required = [
    "apps/web/server.js",
    "apps/web/.next/static",
    "apps/web/public",
    "packages/db/generated/client",
    "packages/db/prisma/schema.prisma",
    // The migrator and admin script sit at the artifact ROOT, not under
    // scripts/ -- that is the layout the installer and the runtime smoke suite
    // both address them at.
    "apply-migrations.mjs",
    "create-admin.mjs",
    "xistance.service.template",
    "release-manifest.json",
  ];
  let missing = 0;
  for (const rel of required) {
    const ok = fs.existsSync(path.join(destination, rel));
    if (!ok) missing += 1;
    console.log(`${ok ? "  ok  " : "  MISS"} ${rel}`);
  }
  if (missing > 0) {
    console.error(`\n${missing} required path(s) missing from the staged artifact`);
    process.exit(1);
  }
  console.log(`\nstaged ${repoRoot} -> ${destination}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
