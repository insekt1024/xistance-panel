/**
 * TASK-79: a Linux release must not carry a native binary built for another OS.
 *
 * The defect this pins shut: the shipped amd64 archive contained
 * `node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.4.node` — a
 * 442,368-byte Windows PE (magic `MZ`) inside a tarball for Ubuntu. The
 * artifact was built on a Windows host and nothing complained, because the only
 * foreign-binary check inspected the generated Prisma client directory. Every
 * other native module arrives through `node_modules`.
 *
 * The platform table is READ FROM the installed `sharp` package's
 * `optionalDependencies`, not hardcoded, so a dependency that adds or drops a
 * platform is covered without editing this file. Two independent assertions:
 *
 *  - every real non-Linux sharp platform blob is reported foreign;
 *  - every real Linux sharp platform blob is NOT reported foreign.
 *
 * A hardcoded list of "bad" filenames would pass while a newly published
 * platform leaked through, which is the failure mode being fixed.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectReleaseArtifact } from "./inspect-release-artifact.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const LINUX = /^(?:linux(?:musl)?|debian|rhel|suse|alpine|al2023|ubi|centos)/i;

let passed = 0;
let failed = 0;
const failures: string[] = [];

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}: ${(error as Error).message.split("\n")[0]}`);
  }
}

/** Minimal artifact skeleton: inspection must reach the tree walk. */
function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-foreign-native-"));
  for (const rel of [
    "server.js",
    "package.json",
    ".next/static/chunks/app.js",
    "public/robots.txt",
    "scripts/apply-migrations.mjs",
    "scripts/create-admin.mjs",
    "tunnels/bin/gost",
    "release-manifest.json",
  ]) {
    const file = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, rel === "release-manifest.json" ? "{}" : "x");
  }
  const client = path.join(root, "packages", "db", "generated", "client");
  fs.mkdirSync(path.join(client, "runtime"), { recursive: true });
  for (const rel of [
    "index.js", "default.js", "schema.prisma",
    "runtime/library.js",
  ]) {
    fs.writeFileSync(path.join(client, ...rel.split("/")), "x");
  }
  fs.writeFileSync(
    path.join(client, "package.json"),
    JSON.stringify({ name: ".prisma/client", version: "6.19.3" }),
  );
  return root;
}

function withNativeBlob(root: string, relative: string): void {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Real PE/Dylib magic where applicable, so the fixture is a genuine binary.
  fs.writeFileSync(file, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]));
}

async function inspect(root: string, architecture?: "amd64" | "arm64"): Promise<string[]> {
  const result = await inspectReleaseArtifact(root, architecture ? { architecture } : undefined);
  return result.errors.filter((error) => error.includes("foreign-platform native binary"));
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // 1. The reported case
  // ---------------------------------------------------------------------------

  const sharpPkgPath = path.join(REPO_ROOT, "node_modules", "sharp", "package.json");
  const sharpAvailable = fs.existsSync(sharpPkgPath);

  await check("the exact reported case: @img/sharp-win32-x64 blob is reported foreign", async () => {
    const root = makeTree();
    try {
      withNativeBlob(root, "node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.4.node");
      const errors = await inspect(root, "amd64");
      assert.equal(errors.length, 1, `expected exactly 1 foreign-binary error, got: ${errors.join(" | ")}`);
      assert.ok(
        errors[0]?.includes("sharp-win32-x64-0.35.4.node"),
        `error must name the offending file: ${errors[0]}`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check("a clean tree reports no foreign native binary", async () => {
    const root = makeTree();
    try {
      withNativeBlob(root, "packages/db/generated/client/libquery_engine-debian-openssl-3.0.x.so.node");
      assert.deepEqual(await inspect(root, "amd64"), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check("the Prisma windows engine is still reported foreign", async () => {
    const root = makeTree();
    try {
      withNativeBlob(root, "packages/db/generated/client/query_engine-windows.dll.node");
      const errors = await inspect(root, "amd64");
      assert.ok(errors.length >= 1, `the Prisma windows engine must be caught, got: ${errors.join(" | ")}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check("non-binary files in a foreign package are not flagged", async () => {
    const root = makeTree();
    try {
      const pkg = path.join(root, "node_modules", "@img", "sharp-win32-x64");
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, "package.json"), '{"name":"@img/sharp-win32-x64"}');
      fs.writeFileSync(path.join(pkg, "index.cjs"), "module.exports={};");
      fs.writeFileSync(path.join(pkg, "README.md"), "# win32 build notes");
      assert.deepEqual(
        await inspect(root, "amd64"),
        [],
        "only the unusable binary may be flagged, not the package's metadata",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await check("inspection without an architecture does not judge platform", async () => {
    const root = makeTree();
    try {
      withNativeBlob(root, "node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.4.node");
      const result = await inspectReleaseArtifact(root);
      assert.equal(
        result.errors.filter((e) => e.includes("foreign-platform native binary")).length,
        0,
        "a local 'native' staging keeps the build host's modules by design",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // 2. The whole real platform matrix, read from the installed sharp package
  // ---------------------------------------------------------------------------

  if (sharpAvailable) {
    const sharpPkg = JSON.parse(fs.readFileSync(sharpPkgPath, "utf8")) as {
      version: string;
      optionalDependencies?: Record<string, string>;
    };
    const tags = Object.keys(sharpPkg.optionalDependencies ?? {}).filter(
      (name) => name.startsWith("@img/sharp-") && !name.includes("libvips"),
    );

    check(`installed sharp exposes its platform matrix (${tags.length} tags)`, async () => {
      assert.ok(tags.length > 0, "no @img/sharp-* platform packages in optionalDependencies");
    });

    for (const tag of tags) {
      const isLinux = LINUX.test(tag.replace("@img/sharp-", ""));
      const blob = `node_modules/${tag}/lib/${tag.replace("@img/sharp-", "sharp-")}-${sharpPkg.version}.node`;
      check(`${isLinux ? "accepts" : "rejects"} ${tag}`, async () => {
        const root = makeTree();
        try {
          withNativeBlob(root, blob);
          const errors = await inspect(root, "amd64");
          if (isLinux) {
            assert.deepEqual(errors, [], `${tag} is a Linux platform and must be accepted`);
          } else {
            assert.equal(errors.length, 1, `${tag} is not Linux and must be rejected: ${errors.join(" | ")}`);
            assert.ok(errors[0]?.includes(tag), `error must name ${tag}`);
          }
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      });
    }
  } else {
    console.log("  skip sharp matrix sweep (sharp not installed)");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`failed: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(`\n${String(e)}`);
  process.exit(1);
});
