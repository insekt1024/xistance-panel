#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Version management for Xistance Panel.
//
//   node scripts/version.mjs [--show]              print current version
//   node scripts/version.mjs --check               verify all synced files match
//   node scripts/version.mjs major|minor|patch     bump the version
//   node scripts/version.mjs set 1.2.3             set an exact version
//   node scripts/version.mjs patch --commit        bump + commit + tag vX.Y.Z
//
// Flags:
//   --commit       commit synced files + create annotated tag vX.Y.Z
//   --allow-dirty  allow --commit with a dirty git tree (CI must be clean)
//   --dry-run      print what would change without writing
//
// The version is kept in sync across:
//   1. package.json (workspace source of truth)
//   2. apps/web/package.json + packages/{types,tunnel-core,i18n,db}/package.json
//   3. apps/web/src/lib/version.ts (APP_VERSION rendered by the UI)
// ---------------------------------------------------------------------------

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Every file whose "version" field must match the root version.
const SYNC_FILES = [
  "package.json",
  "apps/web/package.json",
  "packages/types/package.json",
  "packages/tunnel-core/package.json",
  "packages/i18n/package.json",
  "packages/db/package.json",
];
const VERSION_TS = "apps/web/src/lib/version.ts";

function readJson(p) {
  return JSON.parse(readFileSync(path.join(root, p), "utf8"));
}
function writeJson(p, obj) {
  writeFileSync(path.join(root, p), JSON.stringify(obj, null, 2) + "\n");
}
function sh(cmd) {
  return execSync(cmd, { cwd: root, stdio: "pipe" }).toString().trim();
}

const args = process.argv.slice(2);
const mode = args[0];
const commit = args.includes("--commit");
const dryRun = args.includes("--dry-run");
const allowDirty = args.includes("--allow-dirty");

function currentVersions() {
  const out = new Map();
  for (const f of SYNC_FILES) {
    try {
      out.set(f, readJson(f).version ?? "<missing>");
    } catch {
      out.set(f, "<unreadable>");
    }
  }
  try {
    const src = readFileSync(path.join(root, VERSION_TS), "utf8");
    out.set(VERSION_TS, /APP_VERSION = "([^"]+)"/.exec(src)?.[1] ?? "<missing>");
  } catch {
    out.set(VERSION_TS, "<unreadable>");
  }
  return out;
}

function check() {
  const versions = currentVersions();
  const expected = readJson("package.json").version;
  let ok = true;
  for (const [file, v] of versions) {
    if (v !== expected) {
      console.error(`✗ ${file}: ${v} (expected ${expected})`);
      ok = false;
    }
  }
  if (ok) console.log(`✓ All ${versions.size} version files match ${expected}`);
  process.exit(ok ? 0 : 1);
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
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(s);
}

function assertCleanTree() {
  let status = "";
  try {
    status = sh("git status --porcelain");
  } catch {
    return; // not a git checkout — nothing to guard
  }
  const tracked = status.split("\n").filter((l) => l && !l.startsWith("??"));
  if (tracked.length > 0 && !allowDirty) {
    console.error("Refusing --commit with a dirty git tree. Commit or stash first, or pass --allow-dirty.");
    console.error(tracked.slice(0, 10).join("\n"));
    process.exit(1);
  }
}

function tagExists(tag) {
  try {
    sh(`git rev-parse -q --verify refs/tags/${tag}`);
    return true;
  } catch {
    return false;
  }
}

if (mode === "--show" || mode === undefined) {
  console.log(readJson("package.json").version);
  process.exit(0);
}
if (mode === "--check") check();

let version;
if (mode === "set") {
  version = args[1];
  if (!isSemver(version)) {
    console.error(`Invalid version "${version}". Expected semver like 1.0.0`);
    process.exit(1);
  }
} else if (["major", "minor", "patch"].includes(mode)) {
  version = nextVersion(readJson("package.json").version, mode);
} else {
  console.error("Usage: node scripts/version.mjs [--show|--check|major|minor|patch|set <ver>] [--commit] [--allow-dirty] [--dry-run]");
  process.exit(1);
}

if (dryRun) {
  console.log(`Would set version to ${version} in:`);
  for (const f of [...SYNC_FILES, VERSION_TS]) console.log(`  ${f}`);
  process.exit(0);
}

if (commit) assertCleanTree();

// Keep every package.json in sync.
for (const f of SYNC_FILES) {
  const pkg = readJson(f);
  pkg.version = version;
  writeJson(f, pkg);
}

// Rewrite the UI constant, preserving the repo URL.
const versionFile = path.join(root, VERSION_TS);
const versionSrc = readFileSync(versionFile, "utf8");
const repoUrl = /APP_REPO_URL = "([^"]+)"/.exec(versionSrc)?.[1];
if (!repoUrl) {
  console.error(`Could not find APP_REPO_URL in ${VERSION_TS}; refusing to rewrite.`);
  process.exit(1);
}
writeFileSync(
  versionFile,
  `// Single source of truth for the panel version + repo link.
// Managed by scripts/version.mjs — do not edit by hand.

export const APP_VERSION = "${version}";
export const APP_REPO_URL = "${repoUrl}";
`,
);

console.log(`✓ Version set to ${version} (${SYNC_FILES.length} manifests + version.ts)`);

if (commit) {
  const tag = `v${version}`;
  if (tagExists(tag)) {
    console.error(`Tag ${tag} already exists. Aborting before committing.`);
    process.exit(1);
  }
  execSync(`git add ${[...SYNC_FILES, VERSION_TS].join(" ")}`, { cwd: root, stdio: "inherit" });
  execSync(`git commit -m "chore: release v${version}"`, { cwd: root, stdio: "inherit" });
  execSync(`git tag -a v${version} -m "Release v${version}"`, { cwd: root, stdio: "inherit" });
  console.log(`✓ Committed + tagged v${version} (push with: git push origin HEAD && git push origin tag v${version})`);
}
