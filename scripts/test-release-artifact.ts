/**
 * Focused TASK-5 tests for release artifact staging and inspection.
 * Runs with Node 22/tsx on Windows and Ubuntu without external packages.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  const {
    formatInspectionSummary,
    inspectReleaseArtifact,
    RELEASE_LAYOUT,
    runInspectionCli,
  } = await import("./inspect-release-artifact.ts");
  const { stageReleaseArtifact } = await import("./stage-release-artifact.ts");

  const version = "1.2.0";
  const commit = "0123456789abcdef0123456789abcdef01234567";

  function writeFile(root: string, relativePath: string, content: string): void {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  function makeBareSourceFixture(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-artifact-source-"));
    writeMigrationInput(root);
    const standaloneFiles: Array<[string, string]> = [
      [RELEASE_LAYOUT.server, "fixture\n"],
      [RELEASE_LAYOUT.package, JSON.stringify({ name: "@xistance/web", version })],
      [RELEASE_LAYOUT.buildId, "fixture\n"],
      [RELEASE_LAYOUT.requiredServerFiles, JSON.stringify({ version: 1 })],
      [RELEASE_LAYOUT.nextPackage, JSON.stringify({ name: "next", version: "16.3.0" })],
      [RELEASE_LAYOUT.reactPackage, JSON.stringify({ name: "react", version: "19.2.8" })],
      [RELEASE_LAYOUT.reactDomPackage, JSON.stringify({ name: "react-dom", version: "19.2.8" })],
      [RELEASE_LAYOUT.forwarder, "export {};\n"],
      [RELEASE_LAYOUT.staticChunks + "/app.js", "console.log('app');\n"],
      [RELEASE_LAYOUT.staticChunks + "/app.css", "body{}\n"],
      [RELEASE_LAYOUT.public + "/robots.txt", "User-agent: *\n"],
    ];
    for (const [relativePath, content] of standaloneFiles) {
      writeFile(root, path.join(RELEASE_LAYOUT.standalone, relativePath), content);
    }
    writeFile(root, RELEASE_LAYOUT.manifest, JSON.stringify({
      schemaVersion: 1,
      version,
      releaseTag: `v${version}`,
      commit,
      architecture: "amd64",
      artifact: { format: "tar.gz" },
    }));
    writeFile(root, path.join("scripts", RELEASE_LAYOUT.serviceTemplate), "[Unit]\n");
    writeFile(root, path.join(RELEASE_LAYOUT.standalone, "apps/web/src/runtime-helper.ts"), "export const runtimeOnly = true;\n");
    writeFile(root, path.join(RELEASE_LAYOUT.standalone, "apps/web/app/runtime-helper.js"), "export default true;\n");
    writeFile(root, path.join(RELEASE_LAYOUT.standalone, "apps/web/AGENTS.md"), "development instructions\n");
    writeFile(root, path.join(RELEASE_LAYOUT.standalone, "apps/web/next.config.ts"), "export default {};\n");
    writeFile(root, path.join(RELEASE_LAYOUT.standalone, "apps/web/eslint.config.mjs"), "export default [];\n");
    writeFile(root, path.join(RELEASE_LAYOUT.standalone, "tunnels/tunnels/stale.json"), "{}\n");
    writeFile(root, path.join(RELEASE_LAYOUT.standalone, "tunnels/logs/stale.log"), "log\n");
    writeFile(root, path.join(RELEASE_LAYOUT.standalone, ".env.local"), "JWT_SECRET=should-not-be-copied\n");
    writeFile(root, path.join(RELEASE_LAYOUT.standalone, "data/panel.db"), "not copied");
    writeFile(root, path.join(RELEASE_LAYOUT.standalone, "node_modules/.cache/stale.js"), "not copied");
    return root;
  }

  /**
   * A complete, bootable Prisma client for Linux/amd64 at its real source
   * location (packages/db/generated/client), which is where staging reads it.
   */
  function writeLinuxPrismaClient(root: string, relativeClientDir = "packages/db/generated/client"): void {
    const clientDir = relativeClientDir;
    writeFile(root, `${clientDir}/index.js`, "module.exports = {};\n");
    writeFile(root, `${clientDir}/default.js`, "module.exports = {};\n");
    writeFile(root, `${clientDir}/package.json`, JSON.stringify({ name: ".prisma/client", version: "6.19.3" }));
    writeFile(root, `${clientDir}/schema.prisma`, "datasource db {}\n");
    writeFile(root, `${clientDir}/runtime/library.js`, "module.exports = {};\n");
    writeFile(root, `${clientDir}/libquery_engine-debian-openssl-3.0.x.so.node`, "linux-engine");
  }

  /**
   * A Prisma payload that cannot run on Linux: a Windows engine where a Linux
   * engine is required, and no engine matching the target architecture.
   */
  function writeWindowsOnlyPrismaClient(root: string, relativeClientDir = "packages/db/generated/client"): void {
    const clientDir = relativeClientDir;
    writeFile(root, `${clientDir}/index.js`, "module.exports = {};\n");
    writeFile(root, `${clientDir}/default.js`, "module.exports = {};\n");
    writeFile(root, `${clientDir}/package.json`, JSON.stringify({ name: ".prisma/client", version: "6.19.3" }));
    writeFile(root, `${clientDir}/schema.prisma`, "datasource db {}\n");
    writeFile(root, `${clientDir}/runtime/library.js`, "module.exports = {};\n");
    writeFile(root, `${clientDir}/query_engine-windows.dll.node`, "windows-engine");
  }

  /** Every fixture needs a Prisma client unless a case is specifically about its absence. */
  function makeSourceFixture(options: { prisma?: "linux" | "windows" | "none" } = {}): string {
    const root = makeBareSourceFixture();
    const mode = options.prisma ?? "linux";
    if (mode === "linux") writeLinuxPrismaClient(root);
    else if (mode === "windows") writeWindowsOnlyPrismaClient(root);
    return root;
  }

  /**
   * Migrations must ship in the artifact for a zero-build install. These are
   * written at their real source paths, because staging reads them from
   * repoRoot and copies them into the artifact.
   */
  function writeMigrationInput(root: string): void {
    writeFile(root, "packages/db/prisma/schema.prisma", "datasource db {}\n");
    writeFile(root, "packages/db/prisma/migrations/migration_lock.toml", 'provider = "sqlite"\n');
    writeFile(root, "packages/db/prisma/migrations/20260823214332_init/migration.sql", "CREATE TABLE Tunnel (id TEXT);\n");
    // The Prisma CLI is not shipped, so the applier that replaces
    // `prisma migrate deploy` must be staged too.
    writeFile(root, "scripts/apply-migrations.mjs", "// applier\nimport { DatabaseSync } from \"node:sqlite\";\n");
    writeFile(root, "scripts/create-admin.mjs", "// admin\nimport { DatabaseSync } from \"node:sqlite\";\n");
  }

  function remove(root: string): void {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const sourceRoot = makeSourceFixture();
  const destinationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-artifact-destination-"));
  try {
    await stageReleaseArtifact({ repoRoot: sourceRoot, destination: destinationRoot });
    const staticFile = path.join(destinationRoot, RELEASE_LAYOUT.staticChunks, "app.js");
    assert.ok(fs.existsSync(staticFile), "staged static file must exist");
    assert.ok(fs.existsSync(path.join(destinationRoot, RELEASE_LAYOUT.public, "robots.txt")), "staged public file must exist");
    assert.ok(fs.existsSync(path.join(destinationRoot, RELEASE_LAYOUT.forwarder)), "staged forwarder must exist");
    assert.ok(fs.existsSync(path.join(destinationRoot, RELEASE_LAYOUT.manifest)), "staged manifest must exist");
    assert.ok(fs.existsSync(path.join(destinationRoot, RELEASE_LAYOUT.serviceTemplate)), "staged service template must exist");
    const stagedSource = path.join(destinationRoot, "apps/web/src/runtime-helper.ts");
    assert.ok(fs.existsSync(stagedSource), "traced runtime source must remain available");
    const stagedApp = path.join(destinationRoot, "apps/web/app/runtime-helper.js");
    assert.ok(fs.existsSync(stagedApp), "traced runtime app files must remain available");
    for (const forbidden of [
      "apps/web/AGENTS.md",
      "apps/web/next.config.ts",
      "apps/web/eslint.config.mjs",
      "tunnels/tunnels/stale.json",
      "tunnels/logs/stale.log",
      ".env.local",
      "data/panel.db",
      "node_modules/.cache/stale.js",
    ]) {
      assert.equal(fs.existsSync(path.join(destinationRoot, forbidden)), false, `forbidden path copied: ${forbidden}`);
    }

    const complete = await inspectReleaseArtifact(destinationRoot, { architecture: "amd64" });
    assert.equal(complete.ok, true, complete.errors.join("\n"));
    const noArchitecture = await inspectReleaseArtifact(destinationRoot);
    assert.equal(noArchitecture.ok, true, noArchitecture.errors.join("\n"));
    assert.match(formatInspectionSummary(complete), /PASS/);
    assert.match(formatInspectionSummary(complete), /Checked files: \d+/);

    await stageReleaseArtifact({ repoRoot: sourceRoot, destination: destinationRoot });
    assert.equal(fs.existsSync(path.join(destinationRoot, "stale-from-previous-staging.txt")), false);
  } finally {
    remove(sourceRoot);
    remove(destinationRoot);
  }

  const incompleteSource = makeSourceFixture();
  try {
    fs.rmSync(path.join(incompleteSource, RELEASE_LAYOUT.standalone, RELEASE_LAYOUT.staticChunks, "app.js"));
    await assert.rejects(
      stageReleaseArtifact({ repoRoot: incompleteSource, destination: fs.mkdtempSync(path.join(os.tmpdir(), "xistance-artifact-bad-")) }),
      /static|chunk|stage/i,
    );
  } finally {
    remove(incompleteSource);
  }

  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-artifact-missing-"));
  try {
    const incomplete = await inspectReleaseArtifact(missingRoot, { architecture: "amd64" });
    assert.equal(incomplete.ok, false);
    assert.ok(incomplete.errors.some((error) => error.includes(RELEASE_LAYOUT.server)), "server error required");
    assert.ok(incomplete.errors.some((error) => error.includes(RELEASE_LAYOUT.manifest)), "manifest error required");
  } finally {
    remove(missingRoot);
  }

  const forbiddenRoot = makeSourceFixture();
  try {
    const destination = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-artifact-forbidden-"));
    await stageReleaseArtifact({ repoRoot: forbiddenRoot, destination });
    writeFile(destination, "unexpected.db", "bad");
    const rejected = await inspectReleaseArtifact(destination, { architecture: "amd64" });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.errors.some((error) => error.includes("Forbidden database file")));
    remove(destination);
  } finally {
    remove(forbiddenRoot);
  }

  const mismatchedSource = makeSourceFixture();
  const mismatchedDestination = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-artifact-mismatch-"));
  try {
    await stageReleaseArtifact({ repoRoot: mismatchedSource, destination: mismatchedDestination });
    const mismatched = await inspectReleaseArtifact(mismatchedDestination, { architecture: "arm64" });
    assert.equal(mismatched.ok, false);
    assert.ok(mismatched.errors.some((error) => error.includes("architecture mismatch")));
  } finally {
    remove(mismatchedSource);
    remove(mismatchedDestination);
  }

  // TASK-73: an artifact with no Prisma client at all cannot boot. Staging must
  // refuse to produce a release directory, and the active destination must be untouched.
  const noPrismaSource = makeSourceFixture({ prisma: "none" });
  const noPrismaDestination = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-artifact-noprisma-"));
  try {
    await assert.rejects(
      stageReleaseArtifact({ repoRoot: noPrismaSource, destination: noPrismaDestination, architecture: "amd64" }),
      /prisma/i,
      "staging must reject an artifact with no Prisma client",
    );
    assert.equal(
      fs.readdirSync(noPrismaDestination).length,
      0,
      "a failed staging run must not leave a partial release directory",
    );

    // Inspected directly, the same missing client must also fail with a Prisma-specific error.
    const noPrismaInspected = await inspectReleaseArtifact(noPrismaDestination, { architecture: "amd64" });
    assert.equal(noPrismaInspected.ok, false, "an artifact without a Prisma client must fail inspection");
    assert.ok(
      noPrismaInspected.errors.some((error) => /prisma/i.test(error)),
      `expected a Prisma-specific error, got: ${noPrismaInspected.errors.join("; ")}`,
    );
  } finally {
    remove(noPrismaSource);
    remove(noPrismaDestination);
  }

  // TASK-73: a Windows-only Prisma engine must be rejected for a Linux release.
  const windowsPrismaSource = makeSourceFixture({ prisma: "windows" });
  const windowsPrismaDestination = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-artifact-winprisma-"));
  try {
    await assert.rejects(
      stageReleaseArtifact({ repoRoot: windowsPrismaSource, destination: windowsPrismaDestination, architecture: "amd64" }),
      /engine/i,
      "staging must refuse to ship a Windows-only Prisma engine in a Linux release",
    );
  } finally {
    remove(windowsPrismaSource);
    remove(windowsPrismaDestination);
  }

  // A staged tree that already contains a Windows engine must fail inspection.
  const windowsEngineStaged = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-artifact-winengine-"));
  try {
    writeWindowsOnlyPrismaClient(windowsEngineStaged, RELEASE_LAYOUT.prismaClient);
    const staged = await inspectReleaseArtifact(windowsEngineStaged, { architecture: "amd64" });
    assert.equal(staged.ok, false, "a Windows engine must fail Linux inspection");
    assert.ok(
      staged.errors.some((error) => /no native query engine for amd64/i.test(error)),
      `expected a missing-engine error, got: ${staged.errors.join("; ")}`,
    );
  } finally {
    remove(windowsEngineStaged);
  }

  // TASK-73: entry points without the sibling runtime/ tree load but fail on first
  // real use with MODULE_NOT_FOUND. This is the case a Linux boot test caught.
  const noRuntimeSource = makeSourceFixture({ prisma: "linux" });
  try {
    fs.rmSync(path.join(noRuntimeSource, "packages/db/generated/client/runtime"), {
      recursive: true,
      force: true,
    });
    const noRuntimeDestination = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-artifact-noruntime-"));
    try {
      await assert.rejects(
        stageReleaseArtifact({ repoRoot: noRuntimeSource, destination: noRuntimeDestination, architecture: "amd64" }),
        /runtime/i,
        "staging must reject a Prisma client with no runtime tree",
      );
    } finally {
      remove(noRuntimeDestination);
    }
  } finally {
    remove(noRuntimeSource);
  }

  // TASK-73: the release artifact must be relocatable. Next bakes the build
  // machine's absolute paths into traced chunks, which makes the artifact
  // unusable on the target host. This is the case a real Linux boot caught.
  const absolutePathSource = makeSourceFixture({ prisma: "linux" });
  const absolutePathDestination = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-artifact-abspath-"));
  try {
    // Emulate what the real traced chunk contains: a JSON-escaped build-machine
    // path to the generated client and to the schema.
    const buildRoot = "E:\\\\codes\\\\Projects\\\\repo";
    writeFile(
      absolutePathSource,
      path.join(RELEASE_LAYOUT.standalone, "apps/web/.next/server/chunks/packages_db-fixture.js"),
      `const clientDir = "${buildRoot}\\\\packages\\\\db\\\\generated\\\\client";\n` +
        `const schema = "${buildRoot}\\\\packages\\\\db\\\\prisma\\\\schema.prisma";\n` +
        `export { clientDir, schema };\n`,
    );

    await stageReleaseArtifact({ repoRoot: absolutePathSource, destination: absolutePathDestination, architecture: "amd64" });

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.(?:js|mjs|cjs|json)$/.test(entry)) {
          const text = fs.readFileSync(full, "utf8");
          if (/buildRoot|build-machine/.test(text) || /[A-Za-z]:(?:\\\\){2}codes/.test(text)) offenders.push(full);
        }
      }
    };
    walk(absolutePathDestination);

    assert.deepEqual(
      offenders.map((file) => path.relative(absolutePathDestination, file)),
      [],
      `staging must strip build-machine absolute paths, found: ${offenders.map((f) => path.relative(absolutePathDestination, f)).join(", ")}`,
    );

    const rewritten = fs.readFileSync(
      path.join(absolutePathDestination, "apps/web/.next/server/chunks/packages_db-fixture.js"),
      "utf8",
    );
    assert.doesNotMatch(rewritten, /[A-Za-z]:/, "rewritten chunk must not retain a drive-letter path");
    assert.ok(
      rewritten.includes("packages") && rewritten.includes("db") && rewritten.includes("generated"),
      `path must be rewritten to a release-root-relative form, got: ${rewritten}`,
    );
    assert.doesNotMatch(
      rewritten,
      /"\.packages/,
      "rewritten path must not be prefixed with a dot-segment that resolves from the wrong base",
    );

    // Route strings must survive untouched: rewriting them makes Next throw a
    // "Requested and resolved page mismatch" error at runtime.
    const routeSource = makeSourceFixture({ prisma: "linux" });
    const routeDestination = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-artifact-routes-"));
    try {
      writeFile(
        routeSource,
        path.join(RELEASE_LAYOUT.standalone, "apps/web/.next/server/app-paths-manifest.js"),
        'const p = "/tunnels/route";\nconst q = "/tunnels/[id]/actions/route";\nconst r = "/api/health/route";\nexport { p, q, r };\n',
      );
      await stageReleaseArtifact({ repoRoot: routeSource, destination: routeDestination, architecture: "amd64" });
      const routes = fs.readFileSync(
        path.join(routeDestination, "apps/web/.next/server/app-paths-manifest.js"),
        "utf8",
      );
      assert.match(routes, /"\/tunnels\/route"/, "plain route must be unchanged");
      assert.match(routes, /"\/tunnels\/\[id\]\/actions\/route"/, "dynamic route must be unchanged");
      assert.match(routes, /"\/api\/health\/route"/, "api route must be unchanged");
      assert.doesNotMatch(routes, /\.\.\/\.\.\/tunnels/, "routes must not gain a relative prefix");
    } finally {
      remove(routeSource);
      remove(routeDestination);
    }
  } finally {
    remove(absolutePathSource);
    remove(absolutePathDestination);
  }

  // TASK-73: a complete Linux Prisma client must pass.
  const linuxPrismaSource = makeSourceFixture({ prisma: "linux" });
  const linuxPrismaDestination = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-artifact-linuxprisma-"));
  try {
    await stageReleaseArtifact({ repoRoot: linuxPrismaSource, destination: linuxPrismaDestination, architecture: "amd64" });
    const complete = await inspectReleaseArtifact(linuxPrismaDestination, { architecture: "amd64" });
    assert.equal(complete.ok, true, `complete Linux Prisma client must pass: ${complete.errors.join("; ")}`);
    for (const relative of [
      "packages/db/generated/client/index.js",
      "packages/db/generated/client/default.js",
      "packages/db/generated/client/package.json",
      "packages/db/generated/client/libquery_engine-debian-openssl-3.0.x.so.node",
    ]) {
      assert.ok(fs.existsSync(path.join(linuxPrismaDestination, relative)), `staging must include ${relative}`);
    }
  } finally {
    remove(linuxPrismaSource);
    remove(linuxPrismaDestination);
  }

  const cliSource = makeSourceFixture();
  const cliDestination = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-artifact-cli-"));
  try {
    await stageReleaseArtifact({ repoRoot: cliSource, destination: cliDestination });
    const originalLog = console.log;
    const output: string[] = [];
    console.log = (value: unknown) => { output.push(String(value)); };
    try {
      const code = await runInspectionCli([cliDestination, "--json", "--architecture", "amd64"]);
      assert.equal(code, 0);
    } finally {
      console.log = originalLog;
    }
    const parsed = JSON.parse(output.join("\n")) as { ok?: boolean; errors?: string[] };
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.errors, []);
  } finally {
    remove(cliSource);
    remove(cliDestination);
  }

  console.log("✅ Release artifact inspection: incomplete, complete, forbidden, mismatch, Prisma runtime, staging, and CLI cases passed");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
