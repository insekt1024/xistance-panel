/**
 * Run the release inspection against the arm64 staged tree with the
 * architecture BOUND, so the engine allowlist and the manifest's `architecture`
 * field are both enforced rather than merely reported.
 *
 * `inspect-release-artifact.ts <dir>` reports "Architecture: unspecified" when
 * called without one, which means the architecture contract is not checked at
 * all -- an amd64 engine would pass. This wrapper passes "arm64" explicitly.
 */
import path from "node:path";

import { inspectReleaseArtifact } from "./inspect-release-artifact.ts";

async function main(): Promise<void> {
  const REPO = path.resolve(__dirname, "..");
  const target = process.argv[2] ?? path.join(REPO, "dist", "artifact-arm64");
  const arch = (process.argv[3] ?? "arm64") as "amd64" | "arm64";

  const result = await inspectReleaseArtifact(target, { architecture: arch });
  console.log(`ok        : ${result.ok}`);
  console.log(`arch      : ${result.architecture}`);
  console.log(`files     : ${result.checked}`);
  for (const w of result.warnings) console.log(`WARN  ${w}`);
  for (const e of result.errors) console.log(`ERROR ${e}`);
  process.exit(result.ok ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
