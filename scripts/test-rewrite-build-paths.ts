/**
 * Regression tests for the staged-output path rewriter.
 *
 * This rewriter edits Next build output in place, so a wrong rewrite produces
 * an artifact that installs cleanly, passes checksum and manifest checks, and
 * then fails at runtime with "Cannot find module". That is exactly how a
 * release-breaking bug reached a real Ubuntu host: the per-route manifest
 *
 *   {"/api/tunnels/route": "app/api/tunnels/route.js"}
 *
 * was rewritten to
 *
 *   {"/api/tunnels/route": "app../../tunnels/route.js"}
 *
 * because the POSIX pattern fired on a *relative* path. Every /api/tunnels
 * request then returned 500.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { rewriteBuildMachinePaths } from "./rewrite-build-paths.ts";

const work = mkdtempSync(path.join(os.tmpdir(), "xistance-rewrite-"));

function write(relative: string, contents: string): string {
  const full = path.join(work, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
  return full;
}

function read(relative: string): string {
  return readFileSync(path.join(work, relative), "utf8");
}

async function main(): Promise<void> {
  try {
    // The exact file and content that failed on the host.
    write(
      "apps/web/.next/server/app/api/tunnels/route/app-paths-manifest.json",
      '{\n  "/api/tunnels/route": "app/api/tunnels/route.js"\n}\n',
    );
    // A genuine absolute build-machine path that MUST still be rewritten.
    write(
      "apps/web/.next/server/chunks/absolute.js",
      'const p = "E:\\\\codes\\\\Projects\\\\repo\\\\packages\\\\db\\\\generated\\\\client";\n',
    );
    // A POSIX absolute path, which must also be rewritten.
    write(
      "apps/web/.next/server/chunks/posix.js",
      'const q = "/home/builder/work/repo/apps/web/server.js";\n',
    );
    // Route-like strings must survive untouched.
    write(
      "apps/web/.next/server/routes-manifest.js",
      'self.__BUILD_MANIFEST={"/tunnels/route":"/tunnels/route","/tunnels/[id]/actions/route":"/tunnels/[id]/actions/route"};\n',
    );

    const result = await rewriteBuildMachinePaths(work, "E:\\codes\\Projects\\repo");
    assert.ok(result.filesScanned > 0, "the rewriter must scan the staged tree");
    assert.ok(result.replacements > 0, "genuine absolute paths must be rewritten");

    // --- the regression that mattered ------------------------------------
    const perRoute = read("apps/web/.next/server/app/api/tunnels/route/app-paths-manifest.json");
    assert.equal(
      perRoute,
      '{\n  "/api/tunnels/route": "app/api/tunnels/route.js"\n}\n',
      "a release-relative route manifest must not be rewritten at all",
    );

    // --- absolute paths are still relocated -------------------------------
    const absolute = read("apps/web/.next/server/chunks/absolute.js");
    assert.ok(
      !/E:\\+codes\\+Projects\\+repo/.test(absolute),
      `the build-machine prefix must be removed from an absolute Windows path, got: ${absolute.trim()}`,
    );
    // A Windows path keeps its separators; only the absolute root is
    // dropped and the relative prefix added. Separators are normalised
    // first because the fixture holds escaped backslashes, as real
    // traced JS chunks do.
    const absoluteFlat = absolute.replace(/\\\\/g, "/");
    assert.ok(
      absoluteFlat.includes("../../packages/db/generated/client"),
      `the tail must be preserved and made cwd-relative, got: ${absolute.trim()}`
    );

    const posix = read("apps/web/.next/server/chunks/posix.js");
    assert.ok(
      !posix.includes("/home/builder/work/repo"),
      "the build-machine prefix must be removed from an absolute POSIX path",
    );
    assert.ok(
      posix.includes("../../apps/web/server.js"),
      `the POSIX tail must be preserved, got: ${posix.trim()}`,
    );

    // --- route strings are not paths -------------------------------------
    const routes = read("apps/web/.next/server/routes-manifest.js");
    assert.ok(
      routes.includes('"/tunnels/route":"/tunnels/route"'),
      `a route string must be left alone, got: ${routes.trim()}`,
    );
    assert.ok(
      routes.includes('"/tunnels/[id]/actions/route"'),
      "a dynamic route string must be left alone",
    );

    // --- non-vacuity: the guard is what prevents the regression -----------
    // A second pass must not keep prefixing already-rewritten paths.
    const again = await rewriteBuildMachinePaths(work, "E:\\codes\\Projects\\repo");
    const absoluteAfter = read("apps/web/.next/server/chunks/absolute.js");
    assert.equal(
      absoluteAfter,
      absolute,
      "rewriting twice must be idempotent (no repeated ../../ prefixing)",
    );
    assert.equal(again.replacements, 0, "a second pass must find nothing to rewrite");

    console.log("✅ Build-path rewriter: absolute paths relocated, relative route manifests untouched, idempotent");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

void main();
