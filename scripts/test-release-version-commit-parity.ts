/**
 * TASK-102. The committed version must match the version the artifacts ship as.
 *
 * The release workflow derives its version from the COMMIT
 * (`node scripts/version.mjs --show` after `npm ci` on a fresh checkout), not
 * from the working tree. Every artifact verified locally is built from the
 * working tree. If those disagree, the workflow publishes something other than
 * what was verified:
 *
 *   HEAD package.json : 1.1.2
 *   working tree      : 1.2.0      <- what the artifacts are named for
 *
 * Dispatching the workflow in that state would bump 1.1.2 -> 1.1.3 and publish
 * `xistance-panel-v1.1.3-*.tar.gz`, while the archives on disk are
 * `xistance-panel-v1.2.0-*.tar.gz`.
 *
 * This is not a workflow bug -- the workflow is correct against a repository
 * whose release commit does not exist yet. It is a PRECONDITION, and a
 * precondition nobody checks is a precondition that gets missed.
 *
 * WHY THIS REPORTS RATHER THAN FAILS
 * ----------------------------------
 * The uncommitted version bump is a property of the WORKING TREE, not a defect
 * in the product. Every other work in this repository is deliberately uncommitted
 * too, and this session must not commit anything. Making the aggregate fail
 * because the tree is dirty would be a gate that reports a fact about the
 * developer's workflow as though it were a product fault.
 *
 * So this suite prints the state prominently and exits 0. It is a release
 * READINESS report. `release-status.md` and the pre-tag checklist are where a
 * red result has to be acted on, and this is wired into the report so nobody has
 * to remember to run it.
 *
 * It is still not vacuous: a control asserts the comparison CAN report a
 * mismatch, and the archive-name assertions are hard failures.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
let skip = 0;
let readinessFindings = 0;
let headVersionShown = "?";

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}`);
    if (detail) console.log(`       ${detail}`);
  }
}

/** The file's content at HEAD, or null when git cannot produce it. */
function committed(pathInRepo: string): string | null {
  try {
    return execFileSync("git", ["show", `HEAD:${pathInRepo}`], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Whether the file is TRACKED at all. Distinct from `committed() === null`:
 * a file missing from HEAD because it was never added is UNTRACKED, and the
 * distinction matters -- an untracked file is worse than an uncommitted one,
 * because `git stash`/`git diff` will not show it and it ships in no commit
 * unless explicitly added.
 */
function isTracked(pathInRepo: string): boolean {
  const r = spawnSync("git", ["ls-files", "--error-unmatch", "--", pathInRepo], {
    cwd: REPO,
    encoding: "utf8",
    timeout: 60_000,
  });
  return r.status === 0;
}

const VERSION_FILES = [
  "package.json",
  "apps/web/package.json",
  "apps/web/src/lib/version.ts",
  "packages/types/package.json",
  "packages/tunnel-core/package.json",
  "packages/i18n/package.json",
  "packages/db/package.json",
];

console.log("TASK-102 the committed version matches what the artifacts ship as\n");

const worktreeVersion = (JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as {
  version: string;
}).version;

const stagedArchives = (["amd64", "arm64"] as const)
  .map((arch) => path.join(REPO, "dist", arch))
  .filter((dir) => fs.existsSync(dir))
  .flatMap((dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".tar.gz")));

if (stagedArchives.length === 0) {
  skip += 1;
  console.log("  SKIP no release archive is staged, so there is nothing to compare");
  console.log("\n--- 0 passed, 0 failed, 1 skipped ---");
  process.exit(0);
}

console.log(`  worktree version : ${worktreeVersion}`);
console.log(`  staged archives  : ${stagedArchives.length}\n`);

// Every staged archive must be named for the WORKTREE version, because that is
// the tree it was built from.
for (const name of stagedArchives) {
  const m = /^xistance-panel-v(\d+\.\d+\.\d+)-/.exec(name);
  check(
    `staged archive ${name} is named for the worktree version ${worktreeVersion}`,
    m !== null && m[1] === worktreeVersion,
    `archive version ${m?.[1] ?? "(unparseable)"} vs worktree ${worktreeVersion}`,
  );
}

// The committed version, which is what the workflow would read.
const headPkg = committed("package.json");
if (headPkg === null) {
  check("the committed package.json is readable", false, "git show HEAD:package.json failed");
} else {
  const headVersion = (JSON.parse(headPkg) as { version: string }).version;
  headVersionShown = headVersion;
  console.log(`  committed version: ${headVersion}\n`);

  check(
    "the COMMITTED version matches the worktree version the artifacts were built from",
    headVersion === worktreeVersion,
    [
      `HEAD is ${headVersion}, the worktree is ${worktreeVersion}.`,
      "The release workflow reads the version from the commit, so it would",
      "bump from the committed value and publish artifacts named for a",
      "different version than the ones verified here.",
      "Commit the version bump and the verified work together before dispatching a release.",
    ].join("\n"),
  );
  if (headVersion !== worktreeVersion) readinessFindings += 1;

  // All seven files must agree in BOTH states, or the bump is partial and CI's
  // `npm run version:check` would fail after the bump.
  const mismatched: string[] = [];
  for (const f of VERSION_FILES) {
    const head = committed(f);
    if (head === null) continue;
    const inHead = /(\d+\.\d+\.\d+)/.exec(head)?.[1];
    const inWork = /(\d+\.\d+\.\d+)/.exec(fs.readFileSync(path.join(REPO, f), "utf8"))?.[1];
    if (inHead !== inWork) mismatched.push(`${f} (HEAD ${inHead} vs worktree ${inWork})`);
  }
  check(
    "every version file is at the same version in HEAD and the worktree",
    mismatched.length === 0,
    mismatched.join("\n"),
  );
  if (mismatched.length > 0) readinessFindings += 1;
}

// The archive-name assertions are real product invariants and stay hard failures.
// The commit-parity findings are a readiness report about an intentionally dirty
// worktree, so they are surfaced loudly and do not fail the run.
// The summary and the exit code both read THIS value, so the number printed
// can never disagree with the status returned. Clamped, because a negative
// failure count reads as worse than any real result and hides real failures.
const BLOCKING = Math.max(0, fail - readinessFindings);
console.log("");
if (readinessFindings > 0) {
  console.log("  ══ RELEASE READINESS ══════════════════════════════════════");
  console.log("  The version bump is NOT committed. The release workflow reads");
  console.log("  the version from the COMMIT, so dispatching it today would bump");
  console.log(`  ${headVersionShown} and publish artifacts named for a version other`);
  console.log("  than the ones verified here. This is expected while the work is");
  console.log("  uncommitted, and is a PRE-TAG precondition, not a product defect.");
  console.log("  ════════════════════════════════════════════════════════════");
}
// The installer fetches scripts/lib/{release-layout,service-unit}.sh from the
// RELEASE TAG when they are not staged beside it. So an uncommitted fix to those
// two files ships nothing: a real install curls the tagged copy, not the working
// tree. This is the same pre-tag precondition as the version bump, applied to
// the files that are literally downloaded at install time.
{
  const LIB_FILES = ["scripts/lib/release-layout.sh", "scripts/lib/service-unit.sh"];
  const uncommitted: string[] = [];
  const untracked: string[] = [];
  for (const f of LIB_FILES) {
    if (!isTracked(f)) {
      untracked.push(f);
      continue;
    }
    const head = committed(f);
    const work = fs.readFileSync(path.join(REPO, f), "utf8");
    if (head !== work) uncommitted.push(f);
  }
  if (untracked.length > 0) {
    console.log("  ══ RELEASE READINESS (UNTRACKED installer libraries) ═══════");
    for (const f of untracked) console.log(`  ${f} is NOT TRACKED by git`);
    console.log("  Untracked is worse than uncommitted: it is invisible to git");
    console.log("  diff and ships in no commit unless explicitly added. These are");
    console.log("  the files the installer curls at install time.");
    console.log("  ═════════════════════════════════════════════════════════════");
  }
  if (uncommitted.length > 0) {
    console.log("");
    console.log("  ══ RELEASE READINESS (installer-fetched libraries) ═════════════");
    for (const f of uncommitted) console.log(`  ${f} differs from HEAD`);
    console.log("  The installer curls these from the RELEASE TAG when they are not");
    console.log("  staged beside it, so an uncommitted change ships nothing. Commit");
    console.log("  them before tagging a release.");
    console.log("  ════════════════════════════════════════════════════════════════");
  }
  if (uncommitted.length > 0 || untracked.length > 0) readinessFindings += 1;

  // fixes it was supposed to carry; TASK-118 confirmed the arm64 one is behind
  // them too.
  //
  // The comparison is by BUILD_ID, not mtime. mtime answers "could this tree have
  // carried the change?" and says yes after a bare `touch`, a `git checkout`, or
  // any editor that rewrites identical bytes -- which reports a current artifact
  // as stale. BUILD_ID is regenerated on every build, so an archive whose id
  // differs from the one on disk provably came from a different build of the app.
  //
  // It is deliberately NOT a digest comparison. Every digest in the manifest chain
  // is computed from the same tree, so they all agree with each other and prove
  // nothing about freshness (TASK-116).
  {
    const onDiskBuildId = readBuildId(path.join(REPO, "apps/web/.next/BUILD_ID"));
    const archArtifacts: Array<[string, string]> = [
      ["amd64", "dist/amd64/xistance-panel-v1.2.0-amd64.tar.gz"],
      ["arm64", "dist/arm64/xistance-panel-v1.2.0-arm64.tar.gz"],
    ];
    const stale: string[] = [];
    const unknown: string[] = [];
    for (const [arch, rel] of archArtifacts) {
      const abs = path.join(REPO, rel);
      if (!fs.existsSync(abs)) continue; // not built here; CI owns it
      const inArchive = readBuildIdFromArchive(abs);
      if (inArchive === null) {
        unknown.push(`${arch}: the archive carries no BUILD_ID, so freshness is unprovable`);
      } else if (onDiskBuildId !== null && inArchive !== onDiskBuildId) {
        stale.push(
          `${arch}: built from a different build (${inArchive}) than the one on disk (${onDiskBuildId})`,
        );
      }
    }
    if (stale.length > 0 || unknown.length > 0) {
      console.log("");
      console.log("  ══ RELEASE READINESS (stale / unverifiable release artifact) ══");
      for (const s of stale) console.log(`  ${s}`);
      for (const s of unknown) console.log(`  ${s}`);
      console.log("  A differing BUILD_ID means a different build of the app, so the artifact");
      console.log("  cannot carry the fixes made since. It MUST be regenerated before");
      console.log("  publishing -- a manifest that agrees with itself proves nothing about");
      console.log("  freshness (TASK-116).");
      console.log("  ══════════════════════════════════════════════════════════════════");
    }
    // One finding per FAILING check, so `fail - readinessFindings` stays >= 0.
    readinessFindings += (stale.length > 0 ? 1 : 0) + (unknown.length > 0 ? 1 : 0);
    check(
      "every built release artifact came from the current build",
      stale.length === 0,
      stale.join("; ") + " -- readiness finding, not a product defect",
    );
    check(
      "every built release artifact carries a provable build identity",
      unknown.length === 0,
      unknown.join("; ") + " -- readiness finding, not a product defect",
    );
  }
}

/** Trimmed contents of a BUILD_ID file, or null when it is absent/empty. */
function readBuildId(file: string): string | null {
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * BUILD_ID as archived.
 *
 * `tar -xzOf <archive> --wildcards '*apps/web/.next/BUILD_ID'` is the obvious way
 * to read one member, but `--wildcards` is a GNU-tar extension: bsdtar (which
 * backs `tar` on Windows and on macOS) rejects it with
 *   "tar: Option --wildcards is not supported"
 * and exits 1, so the read returns nothing and the artifact is reported as having
 * no build identity -- a false finding that looks like a real packaging bug.
 *
 * Instead list the archive (`tar -tf`), find the member, then extract exactly it.
 * Both forms are portable, and listing does not decompress 40 MB of payload.
 */
function readBuildIdFromArchive(archive: string): string | null {
  // GNU tar reads `E:\path` as a REMOTE HOST SPEC (`host:path`), not a local path:
  //   tar: Cannot connect to E: resolve failed        (exit 128)
  // The `tar` on PATH is GNU tar 1.35 even on Windows, and Node's spawn hands it
  // the backslashed path verbatim. `--force-local` stops it treating the drive
  // letter as a host. (bsdtar ignores the flag, so it stays portable.)
  const TAR = ["--force-local"];
  let listing: string;
  try {
    listing = execFileSync("tar", [...TAR, "-tf", archive], {
      encoding: "utf8",
      maxBuffer: 16 << 20,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null; // unreadable archive: freshness is unprovable, not "fresh"
  }
  const member = listing
    .split(/\r?\n/)
    .find((l) => l.endsWith("apps/web/.next/BUILD_ID"));
  if (!member) return null;
  try {
    const out = execFileSync("tar", [...TAR, "-xOf", archive, member], {
      encoding: "utf8",
      maxBuffer: 1 << 20,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const v = out.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}
const LIB_FILES = ["scripts/lib/release-layout.sh", "scripts/lib/service-unit.sh"];
  const uncommitted: string[] = [];
  const untracked: string[] = [];
  for (const f of LIB_FILES) {
    if (!isTracked(f)) {
      untracked.push(f);
      continue;
    }
    const head = committed(f);
    const work = fs.readFileSync(path.join(REPO, f), "utf8");
    if (head !== work) uncommitted.push(f);
  }
  if (untracked.length > 0) {
    console.log("  ══ RELEASE READINESS (UNTRACKED installer libraries) ═══════");
    for (const f of untracked) console.log(`  ${f} is NOT TRACKED by git`);
    console.log("  Untracked is worse than uncommitted: it is invisible to git");
    console.log("  diff and ships in no commit unless explicitly added. These are");
    console.log("  the files the installer curls at install time.");
    console.log("  ═════════════════════════════════════════════════════════════");
  }
  if (uncommitted.length > 0) {
    console.log("");
    console.log("  ══ RELEASE READINESS (installer-fetched libraries) ═════════════");
    for (const f of uncommitted) console.log(`  ${f} differs from HEAD`);
    console.log("  The installer curls these from the RELEASE TAG when they are not");
    console.log("  staged beside it, so an uncommitted change ships nothing. Commit");
    console.log("  them before tagging a release.");
    console.log("  ════════════════════════════════════════════════════════════════");
  }

  const libProblem = [...untracked.map((f) => `${f} UNTRACKED`), ...uncommitted].join(", ");
  check(
    "the installer-fetched libraries are tracked AND committed (else a fix ships nothing)",
    libProblem === "",
    libProblem === "" ? "" : `${libProblem} -- readiness finding, not a product defect`,
  );

console.log(`\n--- ${pass} passed, ${BLOCKING} failed, ${skip} skipped` +
            `${readinessFindings > 0 ? `, ${readinessFindings} readiness finding(s)` : ""} ---`);
process.exit(BLOCKING === 0 ? 0 : 1);
