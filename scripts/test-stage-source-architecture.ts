/**
 * TASK-81: staging must take the Prisma engines from the build it is staging,
 * not from whatever happens to be in the local checkout.
 *
 * The defect this pins shut: `stageReleaseArtifact()` hardcoded its standalone
 * root to `<repo>/apps/web/.next/standalone` and its Prisma client root to
 * `<repo>/packages/db/generated/client`. Both are correct only when the build ran
 * on the same machine as the staging run. Producing the first arm64 release
 * artifact from this Windows host hit exactly that:
 *
 *   Generated Prisma client has no native query engine for arm64 in
 *   ...\packages\db\generated\client. Found:
 *   libquery_engine-debian-openssl-3.0.x.so.node,
 *   libquery_engine-linux-musl-openssl-3.0.x.so.node,
 *   query_engine-windows.dll.node.
 *
 * The payload would have been arm64 while the engines inside it were x64 and
 * Windows — an artifact whose manifest and contents disagreed.
 *
 * Two properties are asserted here, and the second is the one that matters:
 *
 *  1. an explicit standalone root is honoured;
 *  2. when one is given, the Prisma client defaults to the tree being staged,
 *     so a caller cannot point the payload at one build and silently get
 *     another build's engines.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stageReleaseArtifact } from "./stage-release-artifact.ts";
import { RELEASE_LAYOUT } from "./inspect-release-artifact.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `       ${line}`)
    .join("\n");
}

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(name);
    // Inspection errors are multi-line; only the first line was shown, which hid
    // the actual reason ("Staged release artifact failed inspection:").
    console.log(`  FAIL ${name}:\n${indent((error as Error).message)}`);
  }
}

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/**
 * A minimal tree shaped like a Next standalone output. The stager requires
 * `RELEASE_LAYOUT.server`, `.public` and `.staticChunks`, so all three are
 * created; the client lives at `RELEASE_LAYOUT.prismaClient`.
 */
function makeStandalone(root: string, engineNames: string[], marker = "build"): void {
  // A file that exists ONLY in this tree. The Prisma client is staged from a
  // separate source, so client contents cannot prove which payload was used;
  // this marker can.
  write(path.join(root, "BUILD-MARKER.txt"), `${marker}\n`);
  write(path.join(root, RELEASE_LAYOUT.server), `// standalone server (${marker})\n`);
  write(path.join(root, RELEASE_LAYOUT.package), JSON.stringify({ name: "web" }));
  write(path.join(root, RELEASE_LAYOUT.public, "xistance-logo.svg"), "<svg/>\n");
  write(path.join(root, RELEASE_LAYOUT.buildId), "testbuild\n");
  write(path.join(root, RELEASE_LAYOUT.staticChunks, "main.js"), "console.log(1);\n");
  write(path.join(root, RELEASE_LAYOUT.staticChunks, "app.css"), "body{}\n");
  write(path.join(root, RELEASE_LAYOUT.app, ".next", "required-server-files.json"), "{}\n");
  write(path.join(root, "node_modules", "next", "package.json"), '{"name":"next"}\n');
  write(path.join(root, "node_modules", "react", "package.json"), '{"name":"react"}\n');
  write(path.join(root, "node_modules", "react-dom", "package.json"), '{"name":"react-dom"}\n');
  write(path.join(root, RELEASE_LAYOUT.forwarder), "export const forwarder = true;\n");

  const client = path.join(root, RELEASE_LAYOUT.prismaClient);
  write(path.join(client, "index.js"), "export const marker = 'this-build';\n");
  write(path.join(client, "default.js"), "export default {};\n");
  write(path.join(client, "package.json"), JSON.stringify({ name: "client", main: "index.js" }));
  write(path.join(client, "runtime", "library.js"), "module.exports = {};\n");
  for (const name of engineNames) write(path.join(client, name), "fake-elf");
}

/** A repo with the minimum files `stageReleaseArtifact` requires. */
const FULL_SHA = "0".repeat(40);

function writeManifest(root: string, architecture: string): void {
  write(
    path.join(root, RELEASE_LAYOUT.manifest),
    JSON.stringify({
      schemaVersion: 1,
      version: "1.2.0",
      releaseTag: "v1.2.0",
      commit: FULL_SHA,
      architecture,
      artifact: { format: "tar.gz", name: `xistance-panel-v1.2.0-${architecture}.tar.gz` },
    }),
  );
}

function makeRepo(
  root: string,
  clientEngines: string[],
  architecture = "amd64",
  repoBuildMarker = "repo-build",
): void {
  writeManifest(root, architecture);
  write(path.join(root, "scripts", RELEASE_LAYOUT.serviceTemplate), "[Unit]\nDescription=test\n");
  write(path.join(root, "packages", "db", "prisma", "schema.prisma"), "datasource db {\n}\n");
  write(path.join(root, "packages", "db", "prisma", "migrations", "migration_lock.toml"), "provider = \"sqlite\"\n");
  write(
    path.join(root, "packages", "db", "prisma", "migrations", "0001_init", "migration.sql"),
    "CREATE TABLE t(a);",
  );
  write(path.join(root, "scripts", "apply-migrations.mjs"), "export const ok = true;\n");
  write(path.join(root, "scripts", "create-admin.mjs"), "export const ok = true;\n");
  makeStandalone(path.join(root, "apps", "web", ".next", "standalone"), clientEngines, repoBuildMarker);
  makeStandalone(root, clientEngines, repoBuildMarker);
}

function enginesIn(root: string): string[] {
  const dir = path.join(root, RELEASE_LAYOUT.prismaClient);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith(".node"))
    .sort();
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

async function main(): Promise<void> {
  const scratch = tempDir("xt-stage-src");

  try {
    // The x64 engines a Windows checkout would leave behind, named exactly as
    // they appear on disk today.
    const X64 = [
      "libquery_engine-debian-openssl-3.0.x.so.node",
      "libquery_engine-linux-musl-openssl-3.0.x.so.node",
      "query_engine-windows.dll.node",
    ];
    const ARM64 = [
      "libquery_engine-linux-arm64-openssl-3.0.x.so.node",
      "libquery_engine-linux-musl-arm64-openssl-3.0.x.so.node",
    ];

    await check("an explicit standalone root is staged instead of the repo build", async () => {
      const repo = path.join(scratch, "repo-explicit");
      // The repo checkout holds the Windows/amd64 engines; the separate build
      // holds arm64. Both trees satisfy every required-file check, so only the
      // *contents* can tell which one was staged -- which is the point. If they
      // were identical the case would pass even with the option ignored.
      makeRepo(repo, X64, "arm64");
      assert.notDeepEqual(
        enginesIn(path.join(repo, "apps", "web", ".next", "standalone")),
        ARM64,
        "fixture sanity: the repo build must NOT already hold the arm64 engines",
      );

      const armBuild = path.join(scratch, "build-arm64");
      makeStandalone(armBuild, ARM64, "explicit-build");

      const dest = path.join(scratch, "out-explicit");
      await stageReleaseArtifact({
        repoRoot: repo,
        destination: dest,
        architecture: "arm64",
        standaloneRoot: armBuild,
      });

      assert.deepEqual(
        enginesIn(dest),
        ARM64,
        `expected the staged artifact to carry the explicit build's engines, got ${enginesIn(dest).join(", ")}`,
      );
      assert.equal(
        fs.readFileSync(path.join(dest, "BUILD-MARKER.txt"), "utf8"),
        "explicit-build\n",
        "payload must come from the explicit standalone root, not the repo build",
      );
    });

    await check("the Prisma client defaults to the staged tree, not the repo checkout", async () => {
      // No --prisma-client given. The in-repo client holds x64 + Windows
      // engines; the standalone tree holds arm64. If the client were still
      // resolved from the repo, staging for arm64 would fail here — which is
      // precisely the failure that started this.
      const repo = path.join(scratch, "repo-default-client");
      makeRepo(repo, X64, "arm64");

      const armBuild = path.join(scratch, "build-arm64-2");
      makeStandalone(armBuild, ARM64);

      const dest = path.join(scratch, "out-default-client");
      await stageReleaseArtifact({
        repoRoot: repo,
        destination: dest,
        architecture: "arm64",
        standaloneRoot: armBuild,
      });

      assert.deepEqual(
        enginesIn(dest),
        ARM64,
        "client engines must come from the tree being staged",
      );
    });

    await check("an explicit client source still overrides both", async () => {
      const repo = path.join(scratch, "repo-explicit-client");
      makeRepo(repo, X64, "arm64");
      const armBuild = path.join(scratch, "build-arm64-3");
      makeStandalone(armBuild, ARM64);

      // prismaClientSource names the client directory itself, so point it at
      // the client inside a full tree rather than passing a tree root.
      const custom = path.join(scratch, "custom-build", RELEASE_LAYOUT.prismaClient);
      makeStandalone(path.join(scratch, "custom-build"), ARM64);
      write(path.join(custom, "index.js"), "export const marker = 'custom';\n");
      // The override points directly at the client directory.

      const dest = path.join(scratch, "out-explicit-client");
      await stageReleaseArtifact({
        repoRoot: repo,
        destination: dest,
        architecture: "arm64",
        standaloneRoot: armBuild,
        prismaClientSource: custom,
      });

      const client = path.join(dest, RELEASE_LAYOUT.prismaClient, "index.js");
      assert.equal(
        fs.readFileSync(client, "utf8"),
        "export const marker = 'custom';\n",
        "an explicit client source must win over the staged tree",
      );
    });

    await check("without standaloneRoot the repo build is still used", async () => {
      // The pre-existing behaviour must not change for the normal path, or every
      // current release invocation breaks.
      const repo = path.join(scratch, "repo-legacy");
      makeRepo(repo, X64);

      const dest = path.join(scratch, "out-legacy");
      await stageReleaseArtifact({
        repoRoot: repo,
        destination: dest,
        architecture: "amd64",
      });

      assert.deepEqual(
        enginesIn(dest),
        [
          "libquery_engine-debian-openssl-3.0.x.so.node",
          "libquery_engine-linux-musl-openssl-3.0.x.so.node",
        ],
        "legacy path must keep using the in-repo client, minus foreign engines",
      );
    });

    await check("a foreign-only client is rejected for the target architecture", async () => {
      // The guard must still fire: pointing at a Windows-only tree for arm64 is
      // an error, not a silently thin artifact.
      const repo = path.join(scratch, "repo-reject");
      makeRepo(repo, X64, "arm64");
      const winBuild = path.join(scratch, "build-win");
      makeStandalone(winBuild, ["query_engine-windows.dll.node"]);

      const dest = path.join(scratch, "out-reject");
      await assert.rejects(
        stageReleaseArtifact({
          repoRoot: repo,
          destination: dest,
          architecture: "arm64",
          standaloneRoot: winBuild,
        }),
        /no native query engine for arm64/i,
        "a tree with no target-architecture engine must be refused",
      );
      assert.equal(fs.existsSync(dest), false, "a rejected stage must leave no partial artifact");
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`  failing: ${failures.join(", ")}`);
    console.log(`\nRESULT: FAIL`);
    process.exitCode = 1;
  } else {
    console.log("\nRESULT: PASS");
  }
}

void main();

// Keep the repo root referenced so the import is not tree-shaken in tooling.
void REPO_ROOT;