/**
 * Recompute the staged payload digest and print it, so a build pipeline can
 * assert it matches the manifest without reimplementing the walk.
 *
 *   node --experimental-strip-types recompute.mjs <tree>   (or via tsx)
 *
 * Exists because "reimplement the digest in shell" is a NEW algorithm, not a
 * check of the original: the helper sorts per directory during a depth-first
 * walk, while a shell `find | sort` sorts globally. Same tree, different order,
 * different digest.
 */
import { stagedPayloadDigest } from "./release-manifest.ts";

const tree = process.argv[2] ?? "dist/artifact";
process.stdout.write(`${await stagedPayloadDigest(tree)}\n`);
