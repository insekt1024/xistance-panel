/**
 * Deterministic release manifest and SHA-256 checksum helpers (TASK-7).
 *
 * Checksums prove content integrity only. They are not supply-chain
 * provenance; that is a separate, conditional release concern.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

export type ReleaseArchitecture = "amd64" | "arm64";

export interface ReleaseRuntime {
  node: string;
  next: string;
  prisma: string;
}

/**
 * The minimum Node major the release supports, as enforced by BOTH installers
 * (`NODE_MIN_MAJOR=22` in scripts/release-install.sh and scripts/install.sh).
 *
 * A test asserts this equals the installers' own value, so the manifest cannot
 * drift away from what a target will actually accept.
 */
export const RELEASE_NODE_MIN_MAJOR = "22";

export interface ReleaseManifestInput {
  version: string;
  commit: string;
  architecture: ReleaseArchitecture;
  artifactName: string;
  artifactSha256: string;
  runtime: ReleaseRuntime;
  format?: string;
}

export interface ReleaseManifest {
  schemaVersion: number;
  version: string;
  releaseTag: string;
  commit: string;
  architecture: ReleaseArchitecture;
  artifact: { format: string; name: string; sha256: string };
  runtime: ReleaseRuntime;
}

export interface ManifestInspection {
  ok: boolean;
  manifest: ReleaseManifest | null;
  errors: string[];
}

export interface ChecksumEntry {
  sha256: string;
  name: string;
}

export interface ChecksumVerification {
  ok: boolean;
  errors: string[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const SECRET_KEY_PATTERN = /(password|secret|token|private.?key|database.?url|jwt|credential)/i;
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
const SUPPORTED_ARCHITECTURES: readonly ReleaseArchitecture[] = ["amd64", "arm64"];

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function buildReleaseManifest(input: ReleaseManifestInput): string {
  const manifest: ReleaseManifest = {
    schemaVersion: 1,
    version: input.version,
    releaseTag: `v${input.version}`,
    commit: input.commit,
    architecture: input.architecture,
    artifact: {
      format: input.format ?? "tar.gz",
      name: input.artifactName,
      sha256: input.artifactSha256,
    },
    runtime: input.runtime,
  };
  return `${canonicalJson(manifest)}\n`;
}

export function inspectReleaseManifest(raw: string): ManifestInspection {
  const errors: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, manifest: null, errors: [`Release manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, manifest: null, errors: ["Release manifest must be a JSON object"] };
  }

  const record = parsed as Record<string, unknown>;
  for (const key of ["schemaVersion", "version", "releaseTag", "commit", "architecture", "artifact", "runtime"]) {
    if (!(key in record)) errors.push(`Release manifest is missing required field: ${key}`);
  }

  const version = record.version;
  if (typeof version !== "string" || !SEMVER_PATTERN.test(version)) {
    errors.push("Release manifest version must be a semantic version");
  } else if (record.releaseTag !== `v${version}`) {
    errors.push("Release manifest releaseTag must match v<version>");
  }

  if (typeof record.commit !== "string" || !COMMIT_PATTERN.test(record.commit)) {
    errors.push("Release manifest commit must be a full 40-character Git SHA");
  }

  if (typeof record.architecture !== "string" || !SUPPORTED_ARCHITECTURES.includes(record.architecture as ReleaseArchitecture)) {
    errors.push("Release manifest architecture must be amd64 or arm64");
  }

  const artifact = record.artifact;
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    errors.push("Release manifest artifact must be an object");
  } else {
    const artifactRecord = artifact as Record<string, unknown>;
    for (const key of ["format", "name", "sha256"]) {
      if (typeof artifactRecord[key] !== "string" || artifactRecord[key] === "") {
        errors.push(`Release manifest artifact.${key} must be a non-empty string`);
      }
    }
    if (typeof artifactRecord.sha256 === "string" && !SHA256_PATTERN.test(artifactRecord.sha256)) {
      errors.push("Release manifest artifact.sha256 must be a 64-character lowercase SHA-256 digest");
    }
  }

  const runtime = record.runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    errors.push("Release manifest runtime must be an object");
  } else {
    for (const key of ["node", "next", "prisma"]) {
      const value = (runtime as Record<string, unknown>)[key];
      if (typeof value !== "string" || value === "") errors.push(`Release manifest runtime.${key} must be a non-empty string`);
    }
  }

  const forbiddenKeys: string[] = [];
  const absolutePathKeys: string[] = [];
  collectForbiddenFields(record, "", forbiddenKeys, absolutePathKeys);
  for (const key of forbiddenKeys) errors.push(`Release manifest contains forbidden secret field: ${key}`);
  for (const key of absolutePathKeys) errors.push(`Release manifest field contains an absolute path: ${key}`);

  if (record.schemaVersion !== 1) errors.push(`Unsupported release manifest schemaVersion: ${String(record.schemaVersion)}`);

  return { ok: errors.length === 0, manifest: errors.length === 0 ? (record as unknown as ReleaseManifest) : null, errors };
}

function collectForbiddenFields(
  value: unknown,
  prefix: string,
  forbiddenKeys: string[],
  absolutePathKeys: string[],
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const field = prefix ? `${prefix}.${key}` : key;
    if (SECRET_KEY_PATTERN.test(key)) forbiddenKeys.push(field);
    if (typeof item === "string") {
      if (ABSOLUTE_PATH_PATTERN.test(item)) absolutePathKeys.push(field);
      continue;
    }
    collectForbiddenFields(item, field, forbiddenKeys, absolutePathKeys);
  }
}

export function renderChecksumFile(sha256: string, name: string): string {
  return `${sha256}  ${name}\n`;
}

/**
 * Deterministic digest of a directory tree: SHA-256 over sorted
 * "<sha256-of-file>  <relative-path>\n" lines, normalized to forward slashes.
 * Used for the manifest's payload digest, which must be computable without
 * archiving (an archive cannot contain its own digest).
 */
export async function treeDigest(root: string): Promise<string> {
  const lines: string[] = [];
  async function walk(current: string, relative: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const childPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(childPath, childRelative);
      } else if (entry.isFile()) {
        lines.push(`${hashBuffer(await readFile(childPath))}  ${childRelative}\n`);
      }
    }
  }
  await walk(path.resolve(root), "");
  return hashBuffer(Buffer.from(lines.join(""), "utf8"));
}

/**
 * Digest a release tree the way a downstream verifier will: the whole staged
 * payload, EXCLUDING release-manifest.json.
 *
 * The exclusion is required, not cosmetic. A manifest records the digest of the
 * tree it ships inside; if the digest covered the manifest, writing the digest
 * would change the very bytes being hashed and the value could never be
 * reproduced. A verifier that recomputes the digest therefore has to skip the
 * same file, and both sides must skip the same one.
 *
 * The second trap this closes: digest the STAGED root, not the build output.
 * The archive is assembled from `dist/artifact`, which differs from
 * `apps/web/.next/standalone` by the manifest, the service template, the
 * migration directory, the migration applier and the admin creator. A digest of
 * the build tree describes a tree that is not the one that ships, so a verifier
 * recomputing it against the extracted release rejects a perfectly good archive.
 */
export async function stagedPayloadDigest(root: string, manifestRelative = "release-manifest.json"): Promise<string> {
  const lines: string[] = [];
  async function walk(current: string, relative: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (childRelative === manifestRelative) continue;
      const childPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(childPath, childRelative);
      } else if (entry.isFile()) {
        lines.push(`${hashBuffer(await readFile(childPath))}  ${childRelative}\n`);
      }
    }
  }
  await walk(path.resolve(root), "");
  return hashBuffer(Buffer.from(lines.join(""), "utf8"));
}

export function parseChecksumFile(raw: string): ChecksumEntry[] {
  const entries: ChecksumEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (!match) continue;
    entries.push({ sha256: match[1].toLowerCase(), name: match[2].trim() });
  }
  return entries;
}

export function sha256OfBuffer(data: Buffer): string {
  return hashBuffer(data);
}

function hashBuffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256OfFile(filePath: string): Promise<string> {
  return readFile(filePath).then(sha256OfBuffer);
}

export function verifyChecksumEntry(
  raw: string,
  artifactName: string,
  expectedSha256?: string,
): ChecksumVerification {
  const entries = parseChecksumFile(raw);
  if (entries.length === 0) {
    return { ok: false, errors: ["Checksum file contains no valid SHA-256 entries"] };
  }

  const entry = entries.find((item) => item.name === artifactName);
  if (!entry) {
    return { ok: false, errors: [`Checksum file has no entry for ${artifactName}`] };
  }

  if (expectedSha256 !== undefined) {
    if (!SHA256_PATTERN.test(expectedSha256)) {
      return { ok: false, errors: ["Expected SHA-256 digest is not a 64-character lowercase hex string"] };
    }
    if (entry.sha256 !== expectedSha256) {
      return { ok: false, errors: [`Checksum mismatch for ${artifactName}: file records ${entry.sha256}, expected ${expectedSha256}`] };
    }
  }

  return { ok: true, errors: [] };
}

export function verifyChecksumFile(
  checksumPath: string,
  artifactName: string,
  expectedSha256?: string,
): ChecksumVerification {
  let raw: string;
  try {
    raw = readFileSync(checksumPath, "utf8");
  } catch (error) {
    return { ok: false, errors: [`Checksum file is not readable: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const entryResult = verifyChecksumEntry(raw, artifactName, expectedSha256);
  if (!entryResult.ok) return entryResult;

  const recorded = parseChecksumFile(raw).find((item) => item.name === artifactName)?.sha256;
  if (!recorded) return { ok: false, errors: [`Checksum file has no entry for ${artifactName}`] };

  const artifactPath = path.join(path.dirname(checksumPath), artifactName);
  let actual: string;
  try {
    actual = hashBuffer(readFileSync(artifactPath));
  } catch (error) {
    return { ok: false, errors: [`Artifact is not readable next to the checksum file: ${error instanceof Error ? error.message : String(error)}`] };
  }
  if (actual !== recorded) {
    return { ok: false, errors: [`Artifact digest mismatch for ${artifactName}: computed ${actual}, recorded ${recorded}`] };
  }
  return { ok: true, errors: [] };
}

export async function verifyArtifactDigest(
  artifactPath: string,
  raw: string,
  artifactName = path.basename(artifactPath),
): Promise<ChecksumVerification> {
  const entryResult = verifyChecksumEntry(raw, artifactName);
  if (!entryResult.ok) return entryResult;
  const expected = parseChecksumFile(raw).find((item) => item.name === artifactName)?.sha256;
  if (!expected) return { ok: false, errors: [`Checksum file has no entry for ${artifactName}`] };
  const actual = await sha256OfFile(artifactPath);
  if (actual !== expected) {
    return { ok: false, errors: [`Artifact digest mismatch for ${artifactName}: computed ${actual}, recorded ${expected}`] };
  }
  return { ok: true, errors: [] };
}

export async function verifyArtifactChecksum(artifactPath: string, checksumPath: string): Promise<ChecksumVerification> {
  let raw: string;
  try {
    raw = readFileSync(checksumPath, "utf8");
  } catch (error) {
    return { ok: false, errors: [`Checksum file is not readable: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return verifyArtifactDigest(artifactPath, raw);
}

async function runManifestCli(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "inspect" && rest[0]) {
    const result = inspectReleaseManifest(await readFile(rest[0], "utf8"));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (command === "sha256" && rest[0]) {
    // Write the exact bytes rather than console.log(): renderChecksumFile()
    // already terminates with \n, and console.log would add a second one,
    // producing a trailing blank line that makes `sha256sum -c` warn
    // ("improperly formatted") even though the digest itself is correct.
    process.stdout.write(renderChecksumFile(await sha256OfFile(rest[0]), path.basename(rest[0])));
    return;
  }
  if (command === "verify" && rest[0] && rest[1]) {
    const result = await verifyArtifactChecksum(rest[0], rest[1]);
    for (const error of result.errors) console.error(error);
    console.log(result.ok ? "Checksum verification: PASS" : "Checksum verification: FAIL");
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (command === "build" && rest.length >= 5) {
    const [outPath, version, commit, architecture, artifactName, payloadRoot, prismaOverride] = rest;
    if (architecture !== "amd64" && architecture !== "arm64") {
      console.error(`Unsupported architecture: ${architecture}`);
      process.exitCode = 2;
      return;
    }
    // MUST be `stagedPayloadDigest`, not `treeDigest`.
    //
    // The payload digest is recomputed downstream from the EXTRACTED archive by
    // `stagedPayloadDigest`, which skips release-manifest.json — a file cannot
    // contain its own hash. This CLI was still calling plain `treeDigest`, which
    // INCLUDES the manifest, so it produced a digest that no verifier could
    // reproduce: the value depended on the manifest that was about to be written
    // into the very directory being hashed.
    //
    // Symptom in CI: the "Verify manifest provenance against the archive" step
    // failed with
    //   manifest says : b753332afd3bf302…
    //   archive yields: e731bc6068600941…
    // on a tree whose staged and extracted contents were byte-identical. The
    // archive was correct; the manifest described a different hash function
    // (TASK-105).
    const raw = buildReleaseManifest({
      version,
      commit,
      architecture,
      artifactName,
      artifactSha256: await stagedPayloadDigest(payloadRoot),
      runtime: {
        // The Node the release RUNS on, not the Node that built it.
        //
        // This used to be `process.version`, which on the build host produced
        // "v26.7.0" -- a v-prefixed BUILD-MACHINE version in a field that
        // describes the release's runtime contract, recorded in a manifest that
        // ships to a target running Node 22. Two problems: it named the wrong
        // machine, and the `v` prefix is inconsistent with the plain semver the
        // rest of the field uses (`next`, `prisma`).
        //
        // The authoritative value is the installer's own floor:
        //   scripts/release-install.sh  NODE_MIN_MAJOR=22
        //   scripts/install.sh          NODE_MIN_MAJOR=22
        // so the manifest states what the release requires, which is checkable
        // against the target rather than against the build host.
        node: RELEASE_NODE_MIN_MAJOR,
        next: readDependencyVersion(path.join(payloadRoot, "apps", "web", "package.json"), "next"),
        prisma: prismaOverride && prismaOverride !== "unknown" ? prismaOverride : resolvePrismaVersion(payloadRoot),
      },
    });
    const check = inspectReleaseManifest(raw);
    if (!check.ok) {
      for (const error of check.errors) console.error(error);
      process.exitCode = 1;
      return;
    }
    await writeFile(path.resolve(outPath), raw, "utf8");
    console.log(`Wrote release manifest: ${outPath}`);
    return;
  }
  console.error(
    "Usage: release-manifest.ts <build <out.json> <version> <commit> <amd64|arm64> <artifact-name> <payload-root> | inspect <manifest.json> | sha256 <file> | verify <artifact> <checksum-file> | tree <dir>>",
  );
  process.exitCode = 2;
}

function readPackageVersion(packageJsonPath: string): string {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
    return typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

/** Reads a runtime dependency's declared version from a package manifest. */
function readDependencyVersion(packageJsonPath: string, dependency: string): string {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
    for (const field of ["dependencies", "devDependencies"]) {
      const group = parsed[field];
      if (group && typeof group === "object") {
        const value = (group as Record<string, unknown>)[dependency];
        if (typeof value === "string" && value !== "") return value;
      }
    }
  } catch {
    // fall through to the explicit unknown marker
  }
  return "unknown";
}

/**
 * Resolves the concrete installed Prisma engine version. The generated client
 * records the exact version it was built with, which is the value that must
 * match on the target host.
 */
function resolvePrismaVersion(payloadRoot: string): string {
  const candidates = [
    path.join(payloadRoot, "packages", "db", "generated", "client", "package.json"),
    path.join(payloadRoot, "node_modules", "@prisma", "client", "package.json"),
    path.join(payloadRoot, "node_modules", "prisma", "package.json"),
  ];
  for (const candidate of candidates) {
    const version = readPackageVersion(candidate);
    if (version !== "unknown") return version;
  }
  const dbManifest = path.join(payloadRoot, "packages", "db", "package.json");
  const declared = readDependencyVersion(dbManifest, "@prisma/client");
  return declared === "unknown" ? readPackageVersion(dbManifest) : declared;
}

const invokedBasename = (process.argv[1] ?? "").replace(/\\/g, "/").split("/").pop()?.toLowerCase();

if (invokedBasename === "release-manifest.ts") {
  runManifestCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
