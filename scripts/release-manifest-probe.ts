/**
 * TASK-7 end-to-end probe: build a manifest from real values, write it, then
 * inspect it through the CLI. Used for release verification evidence only.
 *
 * Usage: npx tsx scripts/release-manifest-probe.ts <out-dir> <artifact-name> <sha256> <version> <commit> <arch>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildReleaseManifest, inspectReleaseManifest } from "./release-manifest.ts";

const [outDir, artifactName, sha256, version, commit, architecture] = process.argv.slice(2);

if (!outDir || !artifactName || !sha256 || !version || !commit || !architecture) {
  console.error("Usage: release-manifest-probe.ts <out-dir> <artifact-name> <sha256> <version> <commit> <amd64|arm64>");
  process.exit(2);
}

const raw = buildReleaseManifest({
  version,
  commit,
  architecture: architecture as "amd64" | "arm64",
  artifactName,
  artifactSha256: sha256,
  runtime: { node: process.version, next: "16.3.0", prisma: "6.19.3" },
});

mkdirSync(outDir, { recursive: true });
const manifestPath = path.join(outDir, "release-manifest.json");
writeFileSync(manifestPath, raw);

const result = inspectReleaseManifest(raw);
console.log(`MANIFEST_PATH=${manifestPath}`);
console.log(`MANIFEST_OK=${result.ok}`);
console.log(`MANIFEST_ERRORS=${result.errors.join("; ")}`);
process.exitCode = result.ok ? 0 : 1;
