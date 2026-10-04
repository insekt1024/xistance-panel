/**
 * Stage the arm64 release tree from the arm64 image's standalone output.
 *
 * `scripts/stage-real-artifact.ts` is the amd64 path: it reads the in-repo
 * `apps/web/.next/standalone`, which is a WINDOWS build, and hardcodes
 * `architecture: "amd64"`. Staging arm64 from it would silently mix a Windows
 * payload with arm64 engines. This driver points the same stager at the tree
 * extracted from the real `linux/arm64` image instead.
 *
 * Run AFTER the arm64 image is built and its standalone tree copied out.
 */
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const VERSION = process.env.XT_VERSION ?? "1.2.0";
const ARCH = "arm64";

const standaloneRoot = path.join(REPO, "dist", "arm64-stage");
const destination = path.join(REPO, "dist", `artifact-${ARCH}`);
const prismaClientSource = path.join(REPO, "dist", "arm64-client");

if (!fs.existsSync(standaloneRoot)) {
  console.error(`missing ${path.relative(REPO, standaloneRoot)} — copy the standalone tree from the arm64 image first`);
  process.exit(1);
}

const count = (dir: string): number => {
  let n = 0;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else n += 1;
    }
  };
  walk(dir);
  return n;
};


/** Read a dependency version from a package.json inside the staged tree. */
function readDependencyVersion(pkgPath: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };
    return pkg.dependencies?.next ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  // The stager copies `release-manifest.json` from the repo root verbatim. That
  // file is the AMD64 manifest, so staging arm64 from it would produce an
  // artifact whose embedded manifest says amd64 -- a mismatch the inspector
  // correctly rejects. Swap in the arm64 manifest for the duration of staging
  // and restore the amd64 one afterwards, so the repo is left exactly as found.
  // Same two-pass contract as scripts/stage-real-artifact.ts, for the same
  // reason (TASK-96): the manifest records the digest of the tree it ships
  // inside, so it can only be built once that tree is complete -- and the tree is
  // only complete once staging has copied the manifest in. Pass 1 stages a
  // structurally valid manifest with a provisional digest, the payload digest is
  // taken over that complete tree (skipping the manifest), and pass 2 re-stages
  // with the real one.
  //
  // The amd64 root manifest is preserved and restored: this driver must not leave
  // the repository's manifest describing arm64.
  const rootManifest = path.join(REPO, "release-manifest.json");
  const rootManifestBytes = fs.existsSync(rootManifest) ? fs.readFileSync(rootManifest) : null;

  const { buildReleaseManifest, inspectReleaseManifest, stagedPayloadDigest, RELEASE_NODE_MIN_MAJOR } = await import(
    "./release-manifest.ts"
  );
  const gitSha = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();
  const artifactName = `xistance-panel-v${VERSION}-arm64.tar.gz`;
  const runtime = {
    // The release runtime, NOT the build host's: both installers gate on
    // NODE_MIN_MAJOR=22, and RELEASE_NODE_MIN_MAJOR is the constant a test ties
    // to them. `process.versions.node` made the manifest depend on who staged it --
    // always right on CI (Node 22), wrong on any other host.
    node: RELEASE_NODE_MIN_MAJOR,
    next: readDependencyVersion(path.join(standaloneRoot, "apps", "web", "package.json")),
    prisma: "6.19.3",
  };

  const { stageReleaseArtifact } = await import("./stage-release-artifact.ts");

  const stageOnce = async (manifestRaw: string): Promise<void> => {
    fs.writeFileSync(rootManifest, manifestRaw, "utf8");
    fs.rmSync(destination, { recursive: true, force: true });
    await stageReleaseArtifact({
      repoRoot: REPO,
      destination,
      architecture: ARCH,
      standaloneRoot,
      prismaClientSource: fs.existsSync(prismaClientSource) ? prismaClientSource : undefined,
    });
  };

  try {
    // Pass 1: a VALID manifest with a provisional digest, so the staged tree
    // passes inspection and the digest is taken over a complete tree.
    await stageOnce(
      buildReleaseManifest({
        version: VERSION,
        commit: gitSha,
        architecture: ARCH,
        artifactName,
        artifactSha256: "0".repeat(64),
        runtime,
      }),
    );

    const artifactSha256 = await stagedPayloadDigest(destination);
    const manifestRaw = buildReleaseManifest({
      version: VERSION,
      commit: gitSha,
      architecture: ARCH,
      artifactName,
      artifactSha256,
      runtime,
    });
    const inspection = inspectReleaseManifest(manifestRaw);
    if (!inspection.ok) {
      for (const error of inspection.errors) console.error(`  - ${error}`);
      process.exit(1);
    }
    console.log(`payload digest over ${path.relative(REPO, destination)} = ${artifactSha256}`);

    // Pass 2: re-stage with the real manifest in place.
    await stageOnce(manifestRaw);
  } finally {
    if (rootManifestBytes) fs.writeFileSync(rootManifest, rootManifestBytes);
    else fs.rmSync(rootManifest, { force: true });
    console.log("restored the amd64 release-manifest.json");
  }

  // ---------------------------------------------------------------------
  // Post-staging contract: required paths present, and the engine set is
  // arm64-only. An arm64 artifact carrying an amd64 or Windows engine would
  // install and then fail on the first query.
  // ---------------------------------------------------------------------
  const required = [
    "apps/web/server.js",
    "apps/web/.next/static",
    "apps/web/public",
    "release-manifest.json",
    "apply-migrations.mjs",
    "create-admin.mjs",
    "xistance.service.template",
  ];
  let missing = 0;
  console.log("\nrequired paths:");
  for (const rel of required) {
    const ok = fs.existsSync(path.join(destination, rel));
    if (!ok) missing += 1;
    console.log(`  ${ok ? "ok  " : "MISS"} ${rel}`);
  }

  const clientDir = path.join(destination, "packages", "db", "generated", "client");
  const engines = fs
    .readdirSync(clientDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.startsWith("libquery_engine-"))
    .map((e) => e.name);
  console.log("\nPrisma engines staged:");
  for (const e of engines) console.log(`  ${e}`);
  if (engines.filter((e) => e.includes("arm64")).length === 0) {
    console.error("\nno arm64 query engine staged");
    missing += 1;
  }
  const foreign = engines.filter((e) => !e.includes("arm64"));
  if (foreign.length > 0) {
    console.error(`\nnon-arm64 query engines staged: ${foreign.join(", ")}`);
    missing += 1;
  }

  console.log(`\nstaged ${ARCH}: ${count(destination)} files`);
  if (missing > 0) {
    console.error(`${missing} problem(s); not archiving`);
    process.exit(1);
  }
  console.log("READY to archive");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
