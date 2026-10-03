/**
 * Focused tests for artifact verification before extraction (TASK-12).
 *
 * Covers the contract an installer must satisfy before it is allowed to touch
 * the active release:
 *   - the downloaded bytes match the published SHA-256;
 *   - the manifest agrees with the requested version, architecture and filename;
 *   - the archive layout is safe (no absolute paths, no `..` traversal, no
 *     symlink or hardlink escapes, no unexpected top-level entries);
 *   - failures never echo secret values.
 */
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildReleaseManifest } from "./release-manifest.ts";
import { classifyArchiveEntry, inspectArchiveEntries, verifyDownloadedArtifact } from "./verify-artifact.ts";

const workRoot = mkdtempSync(path.join(os.tmpdir(), "xistance-verify-"));

function cleanup(): void {
  rmSync(workRoot, { recursive: true, force: true });
}

/** Build a real .tar.gz with the given entries. Entry names are used verbatim. */
function makeArchive(
  name: string,
  entries: Array<{ path: string; body?: string; type?: "file" | "symlink" | "dir"; link?: string }>,
  transform?: string[],
): string {
  const archive = path.join(workRoot, name);
  const staging = mkdtempSync(path.join(workRoot, "stage-"));
  for (const entry of entries) {
    if (entry.type === "symlink") {
      // A symlink entry cannot be created portably via `tar --transform`, so
      // create it on disk and archive the path itself.
      const linkPath = path.join(staging, entry.path);
      mkdirSync(path.dirname(linkPath), { recursive: true });
      // `symlinkSync` is unavailable on Windows without privileges, so this path
      // is exercised only where the host supports it.
      symlinkSync(entry.link ?? "target", linkPath);
    } else if (entry.type === "dir") {
      mkdirSync(path.join(staging, entry.path), { recursive: true });
    } else {
      const filePath = path.join(staging, entry.path);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, entry.body ?? "x\n", "utf8");
    }
  }
  // Archive everything that was staged.
  // --force-local: native Windows tar reads "C:" as a remote host otherwise.
  const tarArgs = ["--force-local"];
  if (transform) {
    tarArgs.push("--transform", `s|^\\.|${transform[0]}|`);
  }
  execFileSync("tar", [...tarArgs, "-czf", archive, "-C", staging, "."], { stdio: "ignore" });
  return archive;
}

async function main(): Promise<void> {
  // ---------------------------------------------------------------------------
  // The CLI's exit status is the contract an installer gates extraction on.
  //
  // Regression: setting `process.exitCode` from an async tsx entry point let
  // the process finish with the default 0, so a *tampered* artifact reported
  // success and a valid one reported failure. The CLI must exit explicitly.
  // ---------------------------------------------------------------------------
  {
    // The archive MUST be named the way a real release is named.
    //
    // verify-artifact.ts derives its expected name from --version/--arch
    // (`xistance-panel-v<version>-<arch>.tar.gz`) rather than from the file it
    // was handed, which is what makes the name check mean anything (it used to
    // take `path.basename(artifact)`, a tautology). A fixture called
    // "cli.tar.gz" is therefore now correctly rejected, so this block names its
    // fixture properly and tests the exit-code contract it means to test,
    // rather than accidentally re-testing the filename rule.
    const CLI_ARCHIVE = "xistance-panel-v1.2.0-amd64.tar.gz";
    const archive = makeArchive(CLI_ARCHIVE, [{ path: "apps/web/server.js", body: "x\n" }]);
    const bytes = readFileSync(archive);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const checksumPath = path.join(workRoot, `${CLI_ARCHIVE}.sha256`);
    writeFileSync(checksumPath, `${digest}  ${CLI_ARCHIVE}\n`, "utf8");
    const manifestPath = path.join(workRoot, "cli-manifest.json");
    writeFileSync(
      manifestPath,
      buildReleaseManifest({
        version: "1.2.0",
        commit: "0".repeat(40),
        architecture: "amd64",
        artifactName: CLI_ARCHIVE,
        artifactSha256: digest,
        runtime: { next: "16.3.0", node: "22", prisma: "6.19.3" },
      }),
      "utf8",
    );

    // `npx` is a shell script / .cmd shim, so spawning it on Windows needs a
    // shell; `tsx` itself is resolved from the local node_modules. This repo
    // runs tsx in cjs mode, where __dirname is available and import.meta is not.
    const cliScript = path.join(__dirname, "verify-artifact.ts");
    const cli = (args: string[]): number => {
      const result = spawnSync("npx", ["tsx", cliScript, ...args], {
        encoding: "utf8",
        shell: process.platform === "win32",
      });
      if (result.error) {
        throw new Error(`could not run the verification CLI: ${result.error.message}`);
      }
      return result.status ?? -1;
    };

    const okArgs = [
      "verify",
      "--artifact", archive,
      "--checksum", checksumPath,
      "--manifest", manifestPath,
      "--version", "1.2.0",
      "--arch", "amd64",
    ];
    assert.equal(cli(okArgs), 0, "a valid artifact must exit 0");
    assert.notEqual(
      cli([...okArgs.slice(0, -1), "arm64"]),
      0,
      "a wrong-architecture request must exit non-zero",
    );
    assert.notEqual(cli([]), 0, "invoking the CLI with no arguments must exit non-zero");
  }

  // ---------------------------------------------------------------------------
  // Checksum verification against the real bytes
  // ---------------------------------------------------------------------------
  {
    const archive = makeArchive("good.tar.gz", [
      { path: "apps/web/server.js", body: "console.log(1)\n" },
      { path: "packages/db/generated/client/index.js", body: "module.exports={}\n" },
    ]);
    const bytes = readFileSync(archive);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const checksumPath = path.join(workRoot, "good.tar.gz.sha256");
    writeFileSync(checksumPath, `${digest}  good.tar.gz\n`, "utf8");
    const goodManifest = path.join(workRoot, "good-manifest.json");
    writeFileSync(
      goodManifest,
      buildReleaseManifest({
        version: "1.2.0",
        commit: "0".repeat(40),
        architecture: "amd64",
        artifactName: "good.tar.gz",
        artifactSha256: digest,
        runtime: { next: "16.3.0", node: "22", prisma: "6.19.3" },
      }),
      "utf8",
    );

    const result = await verifyDownloadedArtifact({
      artifactPath: archive,
      checksumPath,
      manifestPath: goodManifest,
      expectedVersion: "1.2.0",
      expectedArchitecture: "amd64",
      expectedArtifactName: "good.tar.gz",
    });

    assert.equal(result.ok, true, `expected a good artifact to verify; errors: ${JSON.stringify(result.errors)}`);
    assert.equal(result.checksumVerified, true, "checksum must be verified against the artifact bytes");
    assert.equal(result.archiveValid, true, `archive must be valid; errors: ${JSON.stringify(result.archiveErrors)}`);
  }

  // A single flipped byte must be rejected.
  {
    const archive = makeArchive("mutated.tar.gz", [{ path: "apps/web/server.js", body: "console.log(1)\n" }]);
    const bytes = readFileSync(archive);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const checksumPath = path.join(workRoot, "mutated.tar.gz.sha256");
    writeFileSync(checksumPath, `${digest}  mutated.tar.gz\n`, "utf8");

    // Corrupt the archive after the checksum was computed.
    const corrupted = readFileSync(archive);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    writeFileSync(archive, corrupted);

    const result = await verifyDownloadedArtifact({
      artifactPath: archive,
      checksumPath,
      expectedVersion: "1.2.0",
      expectedArchitecture: "amd64",
      expectedArtifactName: "mutated.tar.gz",
    });

    assert.equal(result.ok, false, "a mutated artifact must be rejected");
    assert.equal(result.checksumVerified, false, "checksum verification must fail for mutated bytes");
    assert.equal(result.archiveValid, false, "extraction must not be attempted on a checksum mismatch");
  }

  // ---------------------------------------------------------------------------
  // Manifest agreement with the requested release
  // ---------------------------------------------------------------------------
  {
    const archive = makeArchive("manifest.tar.gz", [{ path: "apps/web/server.js", body: "x\n" }]);
    const bytes = readFileSync(archive);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const checksumPath = path.join(workRoot, "manifest.tar.gz.sha256");
    writeFileSync(checksumPath, `${digest}  manifest.tar.gz\n`, "utf8");

    // A real manifest is required before architecture can be checked at all:
    // an artifact alone cannot prove which platform it was built for.
    const manifestDir = mkdtempSync(path.join(workRoot, "man-"));
    const goodManifest = path.join(manifestDir, "release-manifest.json");
    writeFileSync(
      goodManifest,
      buildReleaseManifest({
        version: "1.2.0",
        commit: "0".repeat(40),
        architecture: "amd64",
        artifactName: "manifest.tar.gz",
        artifactSha256: digest,
        runtime: { next: "16.3.0", node: "22", prisma: "6.19.3" },
      }),
      "utf8",
    );

    const matching = await verifyDownloadedArtifact({
      artifactPath: archive,
      checksumPath,
      manifestPath: goodManifest,
      expectedVersion: "1.2.0",
      expectedArchitecture: "amd64",
      expectedArtifactName: "manifest.tar.gz",
    });
    assert.equal(matching.ok, true, `a matching manifest must verify; errors: ${JSON.stringify(matching.errors)}`);

    const wrongArch = await verifyDownloadedArtifact({
      artifactPath: archive,
      checksumPath,
      manifestPath: goodManifest,
      expectedVersion: "1.2.0",
      expectedArchitecture: "arm64",
      expectedArtifactName: "manifest.tar.gz",
    });
    assert.equal(wrongArch.ok, false, "an architecture mismatch must be rejected");
    assert.ok(
      wrongArch.errors.some((message) => /architecture/.test(message)),
      `an architecture error must be reported; got ${JSON.stringify(wrongArch.errors)}`,
    );

    const wrongVersion = await verifyDownloadedArtifact({
      artifactPath: archive,
      checksumPath,
      manifestPath: goodManifest,
      expectedVersion: "9.9.9",
      expectedArchitecture: "amd64",
      expectedArtifactName: "manifest.tar.gz",
    });
    assert.equal(wrongVersion.ok, false, "a version mismatch must be rejected");

    const wrongName = await verifyDownloadedArtifact({
      artifactPath: archive,
      checksumPath,
      manifestPath: goodManifest,
      expectedVersion: "1.2.0",
      expectedArchitecture: "amd64",
      expectedArtifactName: "some-other-file.tar.gz",
    });
    assert.equal(wrongName.ok, false, "an artifact filename mismatch must be rejected");

    // Without a manifest, architecture cannot be proven and the caller must be
    // told so rather than being handed a false "verified".
    const noManifest = await verifyDownloadedArtifact({
      artifactPath: archive,
      checksumPath,
      expectedVersion: "1.2.0",
      expectedArchitecture: "arm64",
      expectedArtifactName: "manifest.tar.gz",
    });
    assert.ok(
      noManifest.errors.some((message) => /manifest/i.test(message)),
      `a missing manifest must be reported; got ${JSON.stringify(noManifest.errors)}`,
    );

    // A malformed manifest must be rejected rather than ignored.
    const malformed = mkdtempSync(path.join(workRoot, "badman-"));
    const badManifest = path.join(malformed, "release-manifest.json");
    writeFileSync(badManifest, "{ this is not json", "utf8");
    const badResult = await verifyDownloadedArtifact({
      artifactPath: archive,
      checksumPath,
      expectedVersion: "1.2.0",
      expectedArchitecture: "amd64",
      expectedArtifactName: "manifest.tar.gz",
      manifestPath: badManifest,
    });
    assert.equal(badResult.ok, false, "a malformed manifest must be rejected");
    assert.ok(
      badResult.errors.some((message) => /manifest/i.test(message)),
      `a manifest error must be reported; got ${JSON.stringify(badResult.errors)}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Archive layout safety
  // ---------------------------------------------------------------------------
  {
    // Absolute path entry. A plain "etc/passwd" is normalised by tar to a
    // relative entry, so the absolute prefix is injected with --transform.
    const absolute = makeArchive("absolute.tar.gz", [{ path: "etc/passwd", body: "x\n" }], ["/"]);
    const absoluteResult = await inspectArchiveEntries(absolute, ["apps/web/server.js"]);
    assert.equal(absoluteResult.ok, false, "an archive entry with an absolute-ish escape must be rejected");

    // Path traversal entry.
    const traversal = makeArchive("traversal.tar.gz", [{ path: "apps/web/../../../etc/shadow", body: "x\n" }]);
    const traversalResult = await inspectArchiveEntries(traversal, ["apps/web/server.js"]);
    assert.equal(traversalResult.ok, false, "a `..` traversal entry must be rejected");

    // Unexpected top-level entry.
    const unexpected = makeArchive("unexpected.tar.gz", [
      { path: "apps/web/server.js", body: "x\n" },
      { path: "sbin/evil", body: "x\n" },
    ]);
    const unexpectedResult = await inspectArchiveEntries(unexpected, ["apps/web/server.js"]);
    assert.equal(unexpectedResult.ok, false, "an unexpected top-level entry must be rejected");
    assert.ok(
      unexpectedResult.errors.some((message) => /sbin/.test(message)),
      `the offending entry must be named; got ${JSON.stringify(unexpectedResult.errors)}`,
    );

    // A well-formed release root must pass.
    const good = makeArchive("goodlayout.tar.gz", [
      { path: "apps/web/server.js", body: "x\n" },
      { path: "packages/db/generated/client/index.js", body: "x\n" },
      { path: "node_modules/next/package.json", body: "{}\n" },
    ]);
    const goodResult = await inspectArchiveEntries(good, ["apps/web/server.js"]);
    assert.equal(goodResult.ok, true, `a valid release layout must pass; errors: ${JSON.stringify(goodResult.errors)}`);

    // A missing required entry must be reported, so a truncated archive that
    // still lists as valid cannot be mistaken for a complete release.
    const incomplete = makeArchive("incomplete.tar.gz", [{ path: "node_modules/next/package.json", body: "{}\n" }]);
    const incompleteResult = await inspectArchiveEntries(incomplete, ["apps/web/server.js"]);
    assert.equal(incompleteResult.ok, false, "an archive missing a required entry must be rejected");
    assert.ok(
      incompleteResult.errors.some((message) => /missing a required entry/.test(message)),
      `the missing entry must be named; got ${JSON.stringify(incompleteResult.errors)}`,
    );

    // Link entries are refused outright. This host does not support creating
    // symlinks, so the check is exercised through a synthetic entry list via
    // the exported classifier rather than through a real archive.
    const linkClassified = classifyArchiveEntry("l apps/web/evil -> /etc/passwd");
    assert.equal(linkClassified.kind, "link", "a leading 'l' marks a symlink entry");
    const hardlinkClassified = classifyArchiveEntry("h apps/web/evil link to apps/web/server.js");
    assert.equal(hardlinkClassified.kind, "link", "a leading 'h' marks a hardlink entry");
    const fileClassified = classifyArchiveEntry("apps/web/server.js");
    assert.equal(fileClassified.kind, "file", "a plain path is a regular file");
    const absoluteClassified = classifyArchiveEntry("//etc/passwd");
    assert.equal(absoluteClassified.kind, "absolute", "a leading-slash path is absolute");
    const traversalClassified = classifyArchiveEntry("apps/web/../../../etc/shadow");
    assert.equal(traversalClassified.kind, "traversal", "a '..' segment is a traversal");
  }

  // ---------------------------------------------------------------------------
  // Failure output must not leak secrets
  // ---------------------------------------------------------------------------
  {
    const secret = "super-secret-jwt-value-12345";
    const archive = makeArchive("secret.tar.gz", [{ path: "apps/web/server.js", body: `TOKEN=${secret}\n` }]);
    const bytes = readFileSync(archive);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const checksumPath = path.join(workRoot, "secret.tar.gz.sha256");
    writeFileSync(checksumPath, `${digest}  secret.tar.gz\n`, "utf8");

    const corrupted = readFileSync(archive);
    corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
    writeFileSync(archive, corrupted);

    const result = await verifyDownloadedArtifact({
      artifactPath: archive,
      checksumPath,
      expectedVersion: "1.2.0",
      expectedArchitecture: "amd64",
      expectedArtifactName: "secret.tar.gz",
    });
    const combined = JSON.stringify(result);
    assert.ok(!combined.includes(secret), `failure output must not echo secret values; got ${combined}`);
  }


  cleanup();
  console.log("✅ Artifact verification: checksum, manifest agreement, archive safety, and secret hygiene all hold");
}

void main();