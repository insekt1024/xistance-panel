#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Version management for Xistance Panel.
//
//   node scripts/version.mjs [--show]              print current version
//   node scripts/version.mjs major|minor|patch     bump the version
//   node scripts/version.mjs set 1.2.3             set an exact version
//   node scripts/version.mjs patch --commit        bump + commit + tag vX.Y.Z
//
// The version is kept in sync across three places:
//   1. root package.json        (workspace source of truth)
//   2. apps/web/package.json    (web workspace version)
//   3. apps/web/src/lib/version.ts  (what the UI footer renders)
//
// With --commit it also creates an annotated tag (vX.Y.Z) and commits.
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function readJson(p) {
  return JSON.parse(readFileSync(path.join(root, p), "utf8"));
}
function writeJson(p, obj) {
  writeFileSync(path.join(root, p), JSON.stringify(obj, null, 2) + "\n");
}

const rootPkg = readJson("package.json");
const webPkg = readJson("apps/web/package.json");

const args = process.argv.slice(2);
const mode = args[0];
const commit = args.includes("--commit");

function show() {
  console.log(rootPkg.version);
  process.exit(0);
}

function nextVersion(current, bump) {
  const [maj, min, pat] = current.split(".").map((n) => Number(n) || 0);
  switch (bump) {
    case "major": return `${maj + 1}.0.0`;
    case "minor": return `${maj}.${min + 1}.0`;
    case "patch": return `${maj}.${min}.${pat + 1}`;
    default: throw new Error(`Unknown bump type: ${bump}`);
  }
}

function isSemver(s) {
  return /^\d+\.\d+\.\d+$/.test(s);
}

let version;
if (mode === "--show" || mode === undefined) {
  show();
} else if (mode === "set") {
  version = args[1];
  if (!isSemver(version)) {
    console.error(`Invalid version "${version}". Expected semver like 1.0.0`);
    process.exit(1);
  }
} else if (["major", "minor", "patch"].includes(mode)) {
  version = nextVersion(rootPkg.version, mode);
} else {
  console.error(
    "Usage: node scripts/version.mjs [--show|major|minor|patch|set <ver>] [--commit]",
  );
  process.exit(1);
}

// Keep the two package.json files in sync
rootPkg.version = version;
webPkg.version = version;
writeJson("package.json", rootPkg);
writeJson("apps/web/package.json", webPkg);

// Rewrite the UI constant
const versionFile = path.join(root, "apps/web/src/lib/version.ts");
const repoUrl = /APP_REPO_URL = "([^"]+)"/.exec(
  readFileSync(versionFile, "utf8"),
)?.[1];
writeFileSync(
  versionFile,
  `// Single source of truth for the panel version + repo link.
// Managed by scripts/version.mjs — do not edit by hand.

export const APP_VERSION = "${version}";
export const APP_REPO_URL = "${repoUrl}";
`,
);

console.log(`✓ Version set to ${version}`);

if (commit) {
  execSync(`git add package.json apps/web/package.json apps/web/src/lib/version.ts`, {
    stdio: "inherit",
  });
  execSync(`git commit -m "chore: release v${version}"`, { stdio: "inherit" });
  execSync(`git tag -a v${version} -m "Release v${version}"`, { stdio: "inherit" });
  console.log(`✓ Committed + tagged v${version}`);
}
