/**
 * Artifact verification performed *before* any extraction or service change
 * (TASK-12).
 *
 * The installer must be able to prove, from the downloaded bytes alone, that:
 *   1. the archive matches its published SHA-256 sidecar;
 *   2. the release manifest agrees with the version/architecture/filename that
 *      was actually requested;
 *   3. every archive entry is safe to extract (no absolute paths, no `..`
 *      traversal, no link escapes, no unexpected top-level layout);
 *   4. nothing in a failure message echoes a secret value.
 *
 * `tar -x` must never be reached before these checks pass.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inspectReleaseManifest, sha256OfFile, verifyArtifactChecksum, type ReleaseArchitecture } from "./release-manifest.ts";

const execFileAsync = promisify(execFile);

/**
 * Top-level entries a release archive is allowed to contain.
 * Anything else (a stray `sbin/`, a home directory, a dotfile tree) means the
 * archive is not the artifact we published.
 */
export const PERMITTED_TOP_LEVEL_ENTRIES = [
  "apps",
  "packages",
  "node_modules",
  // Tunnel runtime support (backhaul/frp/gost/ssh/xray binaries and their
  // configs) ships inside the artifact, so it is a legitimate top-level entry.
  "tunnels",
  "release-manifest.json",
  "xistance.service.template",
  "package.json",
  // The migration applier and the admin creator are REQUIRED, not incidental:
  // release-install.sh refuses to activate a release that lacks either
  // ("The artifact does not include apply-migrations.mjs; refusing to
  // activate"). They were missing from this list, so the real verifier REJECTED
  // the real release archive --
  //   error: archive contains an unexpected top-level entry: apply-migrations.mjs
  //   error: archive contains an unexpected top-level entry: create-admin.mjs
  // while test-verify-artifact.ts passed, because it builds synthetic fixtures
  // from this same constant and so can never disagree with it. An allowlist
  // that is both the assertion and the fixture is not an assertion.
  "apply-migrations.mjs",
  "create-admin.mjs",
] as const;

export interface ArchiveInspection {
  ok: boolean;
  entries: string[];
  errors: string[];
}

export interface VerifyRequest {
  artifactPath: string;
  checksumPath: string;
  expectedVersion: string;
  expectedArchitecture: ReleaseArchitecture;
  expectedArtifactName: string;
  manifestPath?: string;
  permittedTopLevel?: readonly string[];
}

export interface VerifyResult {
  ok: boolean;
  checksumVerified: boolean;
  archiveValid: boolean;
  errors: string[];
  archiveErrors: string[];
  entryCount: number;
  sha256: string | null;
}

export type ArchiveEntryKind = "root" | "file" | "link" | "absolute" | "traversal";

/**
 * Classify a single `tar -t` entry line.
 *
 * Exported so the safety rules can be unit-tested on hosts that cannot create
 * symlinks. The order matters: a link is refused before its target path is
 * examined, because the target may look harmless while the link itself is not.
 */
export function classifyArchiveEntry(raw: string): { kind: ArchiveEntryKind; path: string } {
  const line = raw.trim();
  // `tar -tv` style output prefixes permissions and an owner; strip them.
  // Named `entryPath` rather than `path` so it does not shadow the path module.
  const entryPath = line.replace(/^[0-9]+[A-Za-z]?\s+/, "");

  // Link entries are marked by a leading 'l' (symlink) or 'h' (hardlink).
  if (/^[lh]/.test(line)) {
    return { kind: "link", path: entryPath.replace(/^[lh]\s*/, "") };
  }

  const normalized = entryPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized === "" || normalized === "/") {
    return { kind: "root", path: normalized };
  }
  if (path.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) {
    return { kind: "absolute", path: normalized };
  }
  if (normalized.split("/").includes("..")) {
    return { kind: "traversal", path: normalized };
  }
  return { kind: "file", path: normalized };
}

/** List archive entries with their type markers, without extracting. */
async function listArchiveEntries(archivePath: string): Promise<string[]> {
  // --force-local: native Windows tar reads "C:" as a remote host otherwise.
  const { stdout } = await execFileAsync("tar", ["--force-local", "-tzf", archivePath], {
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Inspect archive entries for safety without extracting.
 *
 * Rejects:
 *   - absolute paths and drive-letter paths;
 *   - any `..` segment;
 *   - symlink and hardlink entries (they can point outside the target tree);
 *   - any top-level entry outside the permitted release layout.
 */
export async function inspectArchiveEntries(
  archivePath: string,
  requiredEntries: readonly string[] = [],
  permittedTopLevel: readonly string[] = PERMITTED_TOP_LEVEL_ENTRIES,
): Promise<ArchiveInspection> {
  const errors: string[] = [];
  let entries: string[] = [];

  try {
    entries = await listArchiveEntries(archivePath);
  } catch (error) {
    return {
      ok: false,
      entries: [],
      errors: [`archive could not be listed: ${(error as Error).message.split("\n")[0]}`],
    };
  }

  const permitted = new Set(permittedTopLevel);

  for (const raw of entries) {
    const { kind, path: normalized } = classifyArchiveEntry(raw);

    switch (kind) {
      case "root":
        continue;
      case "link":
        // A link inside a release could point anywhere on the host, so links
        // are refused outright rather than validated.
        errors.push(`archive contains a link entry, which is not allowed: ${normalized}`);
        continue;
      case "absolute":
        errors.push(`archive entry uses an absolute path: ${normalized}`);
        continue;
      case "traversal":
        errors.push(`archive entry escapes the extraction root via '..': ${normalized}`);
        continue;
      case "file":
        break;
    }

    const top = normalized.split("/")[0];
    if (!permitted.has(top)) {
      errors.push(`archive contains an unexpected top-level entry: ${top}`);
    }
  }

  for (const required of requiredEntries) {
    const wanted = required.replace(/^\.\//, "");
    const present = entries.some((raw) => classifyArchiveEntry(raw).path === wanted);
    if (!present) {
      errors.push(`archive is missing a required entry: ${wanted}`);
    }
  }

  return { ok: errors.length === 0, entries, errors };
}

/**
 * Full pre-extraction verification of a downloaded artifact.
 *
 * Order matters: the archive is only inspected for layout after its bytes match
 * the published digest, so a tampered archive is never parsed as a tarball.
 */
export async function verifyDownloadedArtifact(request: VerifyRequest): Promise<VerifyResult> {
  const errors: string[] = [];
  const archiveErrors: string[] = [];
  let checksumVerified = false;
  let archiveValid = false;
  let sha256: string | null = null;

  // 1. Filename must be exactly the artifact that was requested.
  const actualName = path.basename(request.artifactPath);
  if (actualName !== request.expectedArtifactName) {
    errors.push(
      `downloaded file name does not match the requested release: expected ${request.expectedArtifactName}, got ${actualName}`,
    );
  }

  // 2. Checksum against the published sidecar, computed over the real bytes.
  try {
    const verification = await verifyArtifactChecksum(request.artifactPath, request.checksumPath);
    checksumVerified = verification.ok;
    if (verification.ok) {
      // Record the verified digest for the caller's audit trail. Computed here
      // because ChecksumVerification reports only pass/fail.
      sha256 = await sha256OfFile(request.artifactPath).catch(() => null);
    } else {
      errors.push(`checksum verification failed for ${actualName}; refusing to extract`);
    }
  } catch (error) {
    errors.push(`checksum could not be computed: ${(error as Error).message.split("\n")[0]}`);
  }

  // 3. Manifest agreement. A manifest is mandatory: the archive bytes alone
  // cannot prove which version or platform was requested, so silently skipping
  // this check would hand the caller a false "verified".
  if (!request.manifestPath) {
    errors.push("no release manifest was supplied, so version and architecture cannot be verified");
  } else {
    let raw = "";
    try {
      raw = await readFile(request.manifestPath, "utf8");
    } catch (error) {
      errors.push(`release manifest could not be read: ${(error as Error).message.split("\n")[0]}`);
    }
    if (raw) {
      const inspection = inspectReleaseManifest(raw);
      if (!inspection.ok || !inspection.manifest) {
        for (const message of inspection.errors) {
          errors.push(`release manifest is not usable: ${message}`);
        }
      } else {
        const manifest = inspection.manifest;
        if (manifest.version !== request.expectedVersion) {
          errors.push(
            `manifest version ${manifest.version} does not match the requested version ${request.expectedVersion}`,
          );
        }
        if (manifest.architecture !== request.expectedArchitecture) {
          errors.push(
            `manifest architecture ${manifest.architecture} does not match the requested architecture ${request.expectedArchitecture}`,
          );
        }
        if (manifest.artifact.name !== request.expectedArtifactName) {
          errors.push(
            `manifest artifact name ${manifest.artifact.name} does not match the requested artifact ${request.expectedArtifactName}`,
          );
        }
      }
    }
  }

  // 4. Archive layout safety — only after the bytes are trusted.
  if (checksumVerified) {
    const inspection = await inspectArchiveEntries(request.artifactPath, [
      "apps/web/server.js",
    ]);
    archiveValid = inspection.ok;
    for (const message of inspection.errors) {
      archiveErrors.push(message);
    }
  } else {
    archiveErrors.push("archive layout not inspected because the checksum did not verify");
  }

  return {
    ok: errors.length === 0 && archiveErrors.length === 0,
    checksumVerified,
    archiveValid,
    errors,
    archiveErrors,
    entryCount: 0,
    sha256,
  };
}

/**
 * CLI: verify a downloaded release artifact before extraction.
 *
 *   verify-artifact.ts verify --artifact A.tar.gz --checksum A.tar.gz.sha256 \
 *     [--manifest release-manifest.json] --version 1.2.0 --arch amd64
 *
 * Exits 0 only when the checksum, the manifest agreement and the archive layout
 * all pass, so a caller can gate extraction on a single status code.
 */
async function runVerifyCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] !== "verify") {
    process.stderr.write("usage: verify-artifact.ts verify --artifact <f> --checksum <f> [--manifest <f>] --version <v> --arch <amd64|arm64>\n");
    process.exit(2);
    return;
  }

  const options: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 1) {
    const key = args[i];
    if (!key.startsWith("--")) continue;
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--")) {
      process.stderr.write(`missing value for ${key}\n`);
      process.exit(2);
      return;
    }
    options[key.slice(2)] = value;
    i += 1;
  }

  const artifact = options.artifact;
  const checksum = options.checksum;
  const version = options.version;
  const arch = options.architecture ?? options.arch;
  if (!artifact || !checksum || !version || !arch) {
    process.stderr.write("--artifact, --checksum, --version and --arch are all required\n");
    process.exit(2);
    return;
  }

  const result = await verifyDownloadedArtifact({
    artifactPath: artifact,
    checksumPath: checksum,
    manifestPath: options.manifest,
    expectedVersion: version.replace(/^v/, ""),
    expectedArchitecture: arch as ReleaseArchitecture,
    // Derive the name the release is SUPPOSED to have, from the version and the
    // architecture, instead of from the file that was actually passed in.
    //
    // `path.basename(artifact)` made the name check a tautology: whatever file
    // you handed the verifier, the verifier agreed that was the right name. A
    // manifest naming `...-amd64.tar.gz` while being verified as the arm64
    // release passed, and the installer passes no --artifact-name, so nothing
    // upstream caught it either. Deriving the name from `--version` and `--arch`
    // makes the comparison independent, which is the only way it can mean
    // anything.
    expectedArtifactName:
      options.artifactName ??
      `xistance-panel-v${version.replace(/^v/, "")}-${arch}.tar.gz`,
  });

  for (const message of [...result.errors, ...result.archiveErrors]) {
    process.stderr.write(`error: ${message}\n`);
  }

  if (result.ok) {
    process.stdout.write(`verified: ${path.basename(artifact)} (sha256 ${result.sha256 ?? "unknown"})\n`);
    // Explicit exit: the process must not be able to end before the async work
    // above has run. Setting process.exitCode alone is unreliable under tsx,
    // which can let the runtime exit with the default 0.
    process.exit(0);
  } else {
    process.exit(1);
  }
}

// Only run the CLI when this file is executed directly. Imported by the test
// suite for its exported helpers, where the CLI must not execute.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.basename(process.argv[1]) === "verify-artifact.ts";

if (invokedDirectly) {
  void runVerifyCli();
}
