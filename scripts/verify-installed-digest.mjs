/**
 * Recompute the release payload digest over an INSTALLED release tree.
 *
 * Used on a target host to prove the running release is byte-identical to the
 * artifact that was published. Deliberately shells out to the same helper the
 * stager uses (`stagedPayloadDigest`) rather than reimplementing the walk in
 * shell: a shell one-liner sorted file names GLOBALLY, while the helper sorts
 * per directory during a depth-first walk, so the two produce different digests
 * for the same tree and the comparison is meaningless.
 *
 *   node verify-installed-digest.mjs <releaseDir>
 */
import path from "node:path";

import { stagedPayloadDigest } from "./release-manifest.ts";

async function main(): Promise<void> {
  const target = process.argv[2] ?? "/opt/xistance/current";
  const digest = await stagedPayloadDigest(path.resolve(target));
  process.stdout.write(`${digest}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
