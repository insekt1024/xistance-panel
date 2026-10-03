/**
 * Focused TASK-7 tests for deterministic release manifest and checksum handling.
 * Runs with Node 22/tsx on Windows and Ubuntu without external packages.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VALID = Object.freeze({
  version: "1.2.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  architecture: "amd64" as const,
});

async function main(): Promise<void> {
  const {
    buildReleaseManifest,
    inspectReleaseManifest,
    parseChecksumFile,
    renderChecksumFile,
    verifyChecksumEntry,
    verifyChecksumFile,
    verifyArtifactDigest,
    treeDigest,
  } = await import("./release-manifest.ts");

  const artifactName = "xistance-panel-v1.2.0-amd64.tar.gz";

  const first = buildReleaseManifest({
    ...VALID,
    artifactName,
    artifactSha256: "a".repeat(64),
    runtime: { node: "22.23.2", next: "16.3.0", prisma: "6.19.3" },
  });
  const second = buildReleaseManifest({
    ...VALID,
    artifactName,
    artifactSha256: "a".repeat(64),
    runtime: { node: "22.23.2", next: "16.3.0", prisma: "6.19.3" },
  });

  assert.equal(first, second, "manifest generation must be deterministic");
  assert.ok(first.endsWith("\n"), "manifest must end with a newline");
  assert.deepEqual(Object.keys(JSON.parse(first)), Object.keys(JSON.parse(second)));
  const keys = Object.keys(JSON.parse(first) as Record<string, unknown>);
  assert.deepEqual(keys, [...keys].sort(), "manifest keys must be sorted");

  const valid = inspectReleaseManifest(first);
  assert.equal(valid.ok, true, valid.errors.join("\n"));
  assert.equal(valid.manifest?.releaseTag, "v1.2.0");
  assert.equal(valid.manifest?.artifact.name, artifactName);
  assert.equal(valid.manifest?.artifact.sha256, "a".repeat(64));

  const checksums = renderChecksumFile("a".repeat(64), artifactName);
  const parsed = parseChecksumFile(checksums);
  assert.deepEqual(parsed, [{ sha256: "a".repeat(64), name: artifactName }]);
  assert.equal(verifyChecksumEntry(checksums, artifactName, "a".repeat(64)).ok, true);
  assert.equal(verifyChecksumEntry(checksums, artifactName, "b".repeat(64)).ok, false);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-manifest-"));
  try {
    const artifactPath = path.join(root, artifactName);
    const checksumPath = path.join(root, `${artifactName}.sha256`);
    fs.writeFileSync(artifactPath, "archive-bytes");
    const { createHash } = await import("node:crypto");
    const realDigest = createHash("sha256").update("archive-bytes").digest("hex");
    fs.writeFileSync(checksumPath, renderChecksumFile(realDigest, artifactName));

    const accepted = verifyChecksumFile(checksumPath, artifactName, realDigest);
    assert.equal(accepted.ok, true, accepted.errors.join("\n"));
    assert.equal((await verifyArtifactDigest(artifactPath, renderChecksumFile(realDigest, artifactName))).ok, true);

    fs.appendFileSync(artifactPath, "-mutated");
    const rejected = verifyChecksumFile(checksumPath, artifactName, realDigest);
    assert.equal(rejected.ok, false, "a one-byte artifact change must fail verification");
    const digestRejected = await verifyArtifactDigest(artifactPath, renderChecksumFile(realDigest, artifactName));
    assert.equal(digestRejected.ok, false, "a one-byte artifact change must fail digest verification");
    assert.ok(digestRejected.errors.some((error) => /digest mismatch/i.test(error)));

    const missingEntry = verifyChecksumFile(checksumPath, "other-artifact.tar.gz", realDigest);
    assert.equal(missingEntry.ok, false);
    assert.equal(verifyChecksumFile(path.join(root, "absent.sha256"), artifactName).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // The sidecar is what a user hands to `sha256sum -c`, so its BYTES matter,
  // not just the parsed entry. renderChecksumFile() terminates with \n; the CLI
  // used to print it with console.log(), which appends a second newline and
  // yields a trailing blank line. The digest still verified through our own
  // parser, but sha256sum warned "1 line is improperly formatted" -- so the
  // defect was invisible to every existing assertion. Drive the real CLI.
  {
    const cliRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xt-sidecar-"));
    try {
      const artifact = path.join(cliRoot, artifactName);
      fs.writeFileSync(artifact, "archive-bytes");
      const { execFileSync } = await import("node:child_process");
      const out = execFileSync(
        process.execPath,
        [path.join(import.meta.dirname, "release-manifest.ts"), "sha256", artifact],
        { encoding: "utf8" },
      );
      const { createHash } = await import("node:crypto");
      const expected = createHash("sha256").update("archive-bytes").digest("hex");
      assert.equal(
        out,
        `${expected}  ${artifactName}\n`,
        `sha256 sidecar must be exactly one newline-terminated line, got ${JSON.stringify(out)}`,
      );
      assert.equal(out.split("\n").length, 2, "sidecar must not contain a trailing blank line");
      assert.equal(out.endsWith("\n\n"), false, "a doubled newline makes sha256sum -c warn");
    } finally {
      fs.rmSync(cliRoot, { recursive: true, force: true });
    }
  }

  const canonical = buildReleaseManifest({
    ...VALID,
    artifactName,
    artifactSha256: "a".repeat(64),
    runtime: { node: "22.23.2", next: "16.3.0", prisma: "6.19.3" },
  });
  assert.ok(canonical.includes('"version":"1.2.0"'), "manifest must be compact canonical JSON");
  assert.ok(canonical.includes('"architecture":"amd64"'), "manifest must be compact canonical JSON");
  assert.ok(canonical.includes('"next":"16.3.0"'), "manifest must be compact canonical JSON");

  const negativeCases: Array<[string, RegExp]> = [
    [
      buildReleaseManifest({ ...VALID, artifactName, artifactSha256: "short", runtime: { node: "22.23.2", next: "16.3.0", prisma: "6.19.3" } }),
      /sha256/i,
    ],
    [
      buildReleaseManifest({ ...VALID, commit: "not-a-sha", artifactName, artifactSha256: "a".repeat(64), runtime: { node: "22.23.2", next: "16.3.0", prisma: "6.19.3" } }),
      /commit/i,
    ],
    [
      buildReleaseManifest({ ...VALID, version: "1.2", artifactName, artifactSha256: "a".repeat(64), runtime: { node: "22.23.2", next: "16.3.0", prisma: "6.19.3" } }),
      /semantic version/i,
    ],
    [canonical.replace('"architecture":"amd64"', '"jwtSecret":"x"'), /secret/i],
    [canonical.replace('"architecture":"amd64"', '"architecture":"riscv64"'), /architecture/i],
  ];

  for (const [raw, pattern] of negativeCases) {
    const result = inspectReleaseManifest(raw);
    assert.equal(result.ok, false, `expected rejection for ${pattern}`);
    assert.ok(
      result.errors.some((error) => pattern.test(error)),
      `expected ${pattern} in: ${result.errors.join("; ")}`,
    );
  }

  const localPath = canonical.replace('"next":"16.3.0"', '"next":"/home/user/build"');
  const localPathResult = inspectReleaseManifest(localPath);
  assert.equal(localPathResult.ok, false);
  assert.ok(localPathResult.errors.some((error) => /absolute path/i.test(error)));

  const treeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-tree-"));
  try {
    fs.mkdirSync(path.join(treeRoot, "nested"), { recursive: true });
    fs.writeFileSync(path.join(treeRoot, "b.txt"), "beta");
    fs.writeFileSync(path.join(treeRoot, "a.txt"), "alpha");
    fs.writeFileSync(path.join(treeRoot, "nested", "c.txt"), "gamma");

    const digestA = await treeDigest(treeRoot);
    assert.match(digestA, /^[0-9a-f]{64}$/, "tree digest must be a 64-character lowercase SHA-256 digest");

    const reordering = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-tree-rev-"));
    fs.writeFileSync(path.join(reordering, "a.txt"), "alpha");
    fs.writeFileSync(path.join(reordering, "b.txt"), "beta");
    fs.mkdirSync(path.join(reordering, "nested"), { recursive: true });
    fs.writeFileSync(path.join(reordering, "nested", "c.txt"), "gamma");
    assert.equal(await treeDigest(reordering), digestA, "tree digest must be independent of creation order");
    fs.rmSync(reordering, { recursive: true, force: true });

    fs.writeFileSync(path.join(treeRoot, "a.txt"), "alpha-mutated");
    assert.notEqual(await treeDigest(treeRoot), digestA, "a content change must change the tree digest");
    fs.writeFileSync(path.join(treeRoot, "a.txt"), "alpha");
    assert.equal(await treeDigest(treeRoot), digestA, "restoring content must restore the tree digest");

    fs.writeFileSync(path.join(treeRoot, "extra.txt"), "delta");
    assert.notEqual(await treeDigest(treeRoot), digestA, "an added file must change the tree digest");
  } finally {
    fs.rmSync(treeRoot, { recursive: true, force: true });
  }

  console.log("✅ Release manifest: determinism, checksum, mutation, and negative-field cases passed");
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
