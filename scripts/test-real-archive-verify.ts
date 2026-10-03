/**
 * TASK-89. Run the installer's OWN verification command against a REAL staged
 * release tree.
 *
 * `test-verify-artifact.ts` passes 20+ assertions, and it passed while the real
 * release archive was rejected by the real verifier:
 *
 *   error: archive contains an unexpected top-level entry: apply-migrations.mjs
 *   error: archive contains an unexpected top-level entry: create-admin.mjs
 *
 * The reason is structural. The synthetic fixtures are built from
 * PERMITTED_TOP_LEVEL_ENTRIES, and the inspection defaults to that same
 * constant -- so the allowlist is simultaneously the assertion and the fixture
 * and cannot disagree with itself. Only the real tree disagrees.
 *
 * This suite closes that gap for the platform it can run on. On Windows it
 * builds a real archive with the real `tar` and runs the real verifier over it;
 * where a suitable staged tree does not exist yet it reports SKIP (exit 0) with
 * the reason, never a false pass.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

/**
 * Every architecture that ships. Each has its own staged tree, its own
 * architecture-specific manifest, and its own archive + sidecar.
 *
 * The arm64 case is NOT redundant with amd64. A stale arm64 archive, or one
 * whose embedded manifest still says `amd64`, passes every amd64-only gate:
 * the root manifest is amd64, `test-release-audit` and
 * `test-release-manifest-freshness` never look at arm64, and
 * `test-foreign-native-bins` has a single arm64 assertion. That is how an
 * arm64 artifact can be months out of date and still be "green".
 */
const TARGETS = [
  { arch: "amd64", stage: "dist/amd64" },
  { arch: "arm64", stage: "dist/arm64" },
] as const;

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
    if (detail) console.log(`       ${detail.replace(/\n/g, "\n       ")}`);
  }
}

function digest(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

console.log("TASK-89/95 real release archives vs the real verifier\n");

const VERSIONS: string[] = [];

for (const target of TARGETS) {
  const stage = path.join(REPO, target.stage);
  const manifestPath = path.join(stage, "release-manifest.json");
  // The archive is found by the EXPECTED NAME, never by whatever name the
  // manifest happens to declare. Deriving the filename from the manifest made
  // the "manifest names the archive that exists" assertion a tautology: with a
  // manifest pointing at `...-amd64.tar.gz` the loop simply looked for that file,
  // found it, and passed. Mutation-verified: a manifest naming the wrong
  // architecture's archive now fails, because the expected file is the one that
  // is required to be present and the manifest must agree with it.
  const expectedName = `xistance-panel-v${fs.existsSync(manifestPath)
    ? (JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { version: string }).version
    : "1.2.0"}-${target.arch}.tar.gz`;
  const archive = path.join(stage, expectedName);
  const sidecar = `${archive}.sha256`;

  console.log(`--- ${target.arch} : ${path.relative(REPO, archive)}`);

  if (!fs.existsSync(archive) || !fs.existsSync(sidecar) || !fs.existsSync(manifestPath)) {
    // An architecture that has not been built yet is a skip, NOT a pass. The
    // summary below counts it so a green run cannot hide an unbuilt target.
    check(
      `${target.arch}: a staged archive, sidecar and manifest exist`,
      false,
      `missing: ${[!fs.existsSync(archive) && "archive", !fs.existsSync(sidecar) && "sidecar", !fs.existsSync(manifestPath) && "manifest"].filter(Boolean).join(", ")}`,
    );
    continue;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    version: string;
    architecture: string;
    artifact: { name: string };
  };
  VERSIONS.push(manifest.version);

  // The shipped manifest must name the artifact that actually ships, and must
  // declare the architecture the tree was actually built for. An arm64 archive
  // carrying an amd64 manifest is the exact defect this per-arch loop exists to
  // catch: the amd64-only gates all read the root manifest and never see it.
  check(
    `${target.arch}: the staged manifest names the archive that exists`,
    manifest.artifact.name === path.basename(archive),
    `manifest says "${manifest.artifact.name}", the file is "${path.basename(archive)}"`,
  );
  check(
    `${target.arch}: the manifest declares architecture "${target.arch}"`,
    manifest.architecture === target.arch,
    `manifest says "${manifest.architecture}" but the file is staged under dist/${target.arch}`,
  );

  // The real verifier, the real arguments release-install.sh passes.
  const verified = spawnSync(
    process.execPath,
    [
      path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"),
      path.join(REPO, "scripts", "verify-artifact.ts"),
      "verify",
      "--artifact", archive,
      "--checksum", sidecar,
      "--manifest", manifestPath,
      "--version", manifest.version,
      // Pass the EXPECTED architecture, not whatever the manifest claims. If the
      // manifest said "amd64" and the suite echoed that back as --arch, the
      // verifier would be asked to confirm an amd64 release while reading an
      // arm64 archive, and the name it derives from --arch would match the
      // manifest. Pinning the loop's own architecture keeps the two independent.
      "--arch", target.arch,
    ],
    { encoding: "utf8", cwd: REPO, timeout: 300_000 },
  );
  const output = `${verified.stdout ?? ""}${verified.stderr ?? ""}`;
  check(
    `${target.arch}: the real verifier accepts the real release archive`,
    verified.status === 0,
    `exit ${verified.status}\n${output.slice(0, 900)}`,
  );
}

// ---------------------------------------------------------------------------
// Non-vacuity: the gate must fail when the archive really is unacceptable. A
// verifier that cannot reject anything would pass this suite for the wrong
// reason, which is the failure mode this whole task exists to prevent.
// ---------------------------------------------------------------------------
{
  const amd64Manifest = path.join(REPO, "dist", "amd64", "release-manifest.json");
  if (!fs.existsSync(amd64Manifest)) {
    check("the negative control has a manifest to verify against", false, `missing ${amd64Manifest}`);
  } else {
    const controlManifest = JSON.parse(fs.readFileSync(amd64Manifest, "utf8")) as {
      version: string;
      architecture: string;
    };
    const scratch = fs.mkdtempSync(path.join(REPO, "node_modules", ".cache", "xt-negctl-"));
    try {
      // A tree with a top-level entry no release contains. The verifier must
      // refuse it, proving the checks above have teeth.
      const badTree = path.join(scratch, "tree");
      fs.mkdirSync(path.join(badTree, "definitely-not-a-release"), { recursive: true });
      fs.writeFileSync(path.join(badTree, "definitely-not-a-release", "x"), "x");
      // Archive to a path OUTSIDE badTree. Writing the .tar.gz into the directory
      // being archived makes tar read its own growing output:
      //   tar: .: file changed as we read it
      const badArchive = path.join(scratch, "bad.tar.gz");
      const tar = spawnSync("tar", ["--force-local", "-czf", badArchive, "-C", badTree, "."], {
        encoding: "utf8",
      });
      if (tar.status !== 0) {
        check("a tree with a forbidden entry is rejected (tar available)", false, tar.stderr);
      } else {
        const badSidecar = `${badArchive}.sha256`;
        fs.writeFileSync(badSidecar, `${digest(badArchive)}  ${path.basename(badArchive)}\n`);
        const rejected = spawnSync(
          process.execPath,
          [
            path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"),
            path.join(REPO, "scripts", "verify-artifact.ts"),
            "verify",
            "--artifact", badArchive,
            "--checksum", badSidecar,
            "--manifest", amd64Manifest,
            "--version", controlManifest.version,
            "--arch", controlManifest.architecture,
          ],
          { encoding: "utf8", cwd: REPO, timeout: 300_000 },
        );
        check(
          "a tree with a forbidden top-level entry IS rejected (the gate has teeth)",
          rejected.status !== 0,
          "the verifier accepted a tree containing definitely-not-a-release/, so the checks above prove nothing",
        );
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

console.log(`\narchitectures verified: ${VERSIONS.length ? VERSIONS.join(", ") : "none"}`);
console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
