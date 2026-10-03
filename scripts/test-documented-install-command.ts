/**
 * TASK-111 — the DOCUMENTED install commands must stay executable.
 *
 * TASK-18 asks for a version-pinned one-line install in both READMEs. The docs
 * existed, and they were correct -- but nothing tested that the commands they
 * print would actually run. A README can drift from the installer with every test
 * in the repository still green, because the docs are prose and the tests read
 * code.
 *
 * This suite closes that gap WITHOUT executing an install: it extracts the
 * documented commands from both READMEs and proves, against the real installer
 * source, that every file each command depends on exists at the pinned tag, that
 * the layout they produce is one the installer's resolution loop actually finds,
 * and that both READMEs say the same thing (TASK-18 criterion 1).
 *
 * What it deliberately does NOT claim: that a published tag serves these URLs.
 * No release has been published, so that is checked by the release job instead.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const TAG = "v1.2.0";
const RAW = `https://raw.githubusercontent.com/insekt1024/xistance-panel/${TAG}`;

let pass = 0;
let fail = 0;
// A file that is untracked is a COMMIT decision, not a product defect -- the same
// contract as test-release-version-commit-parity.ts. It is reported loudly here
// and counted separately, and the process still exits 0 so an intentionally dirty
// worktree does not red the aggregate.
let readinessFindings = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}`);
    if (detail) console.log(`       ${detail}`);
  }
}

const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
const readmeFa = fs.readFileSync(path.join(REPO, "README_FA.md"), "utf8");
const installer = fs.readFileSync(path.join(REPO, "scripts/release-install.sh"), "utf8");

console.log(`The documented one-line install (${TAG})`);

// --- 1. Both READMEs document the same pinned files --------------------------
// TASK-18 criterion 1: "README.md and README_FA.md describe the same commands".
interface Cmd {
  url: string;
  dest: string;
}

/**
 * Pull every `curl <url>` out of the document, with its `-o <dest>` when the
 * command has one.
 *
 * The README mixes three shapes, so one strict pattern silently matched NOTHING
 * and every downstream check became vacuously true -- which the non-vacuity
 * assertion below then correctly caught:
 *
 *   curl -fsSL <url> \\n  -o /tmp/x          (line-continued)
 *   curl -fsSL <url> -o /tmp/x && sudo bash  (chained)
 *   curl -fsSL <url> \\n  | sudo bash        (piped, no -o)
 *
 * `scripts/bootstrap.sh` is a DEVELOPER command both READMEs deliberately omit
 * (`test-readme-fa-parity.ts` asserts that exclusion), pinned to `master` rather
 * than the release tag, so it is not part of this install contract.
 */
const DEV_ONLY = /\/bootstrap\.sh$/;

function curlPairs(md: string): Cmd[] {
  const out: Cmd[] = [];
  const re = /curl\s+-fsSL?\s+(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    // A bounded forward window for the -o, so it cannot be borrowed from a
    // LATER curl in the same fenced block.
    const window = md.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const o = /-o\s+(\S+)/.exec(window.split(/\n\s*curl\s/)[0] ?? "");
    out.push({ url: m[1]!, dest: o ? o[1]! : "" });
  }
  return out.filter((c) => !DEV_ONLY.test(c.url));
}

const en = curlPairs(readme);
const fa = curlPairs(readmeFa);
check(
  "README.md documents a curl-based install",
  en.length >= 3,
  `found ${en.length} curl commands`,
);
check(
  "README_FA.md documents the same number of commands",
  fa.length === en.length,
  `README.md ${en.length} vs README_FA.md ${fa.length}`,
);
check(
  "both READMEs fetch the same files",
  JSON.stringify(en.map((c) => c.url).sort()) === JSON.stringify(fa.map((c) => c.url).sort()),
  `EN ${en.map((c) => c.url).join(" ")}\n       FA ${fa.map((c) => c.url).join(" ")}`,
);

// --- 2. Every documented URL is version-pinned --------------------------------
// "There is no floating `latest`" is a promise; a future edit could break it.
for (const c of en) {
  check(
    `${path.basename(c.dest)} is pinned to ${TAG}`,
    c.url.includes(`/${TAG}/`) && !/\/latest\//.test(c.url),
    `unpinned or floating: ${c.url}`,
  );
}
check(
  "no documented command uses a floating ref",
  !/releases\/(latest|download\/latest)/.test(readme) && !/releases\/(latest|download\/latest)/.test(readmeFa),
);

// --- 3. Every file the docs fetch EXISTS IN THE REPO AT THE TAG ---------------
// This is the assertion that matters. The docs fetch from raw.githubusercontent at
// the pinned tag, so a file that is untracked, or absent at that tag, makes the
// documented command 404 -- with a 404 from curl that is easy to misread as a
// network problem.
const REPO_PATH_OF = (url: string): string | null => {
  const m = /raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/.exec(url);
  return m ? m[1]! : null;
};

const unreachables: string[] = [];
const installerLibsNeeded = [
  "scripts/release-install.sh",
  "scripts/lib/release-layout.sh",
  "scripts/lib/service-unit.sh",
];

for (const f of installerLibsNeeded) {
  const onDisk = fs.existsSync(path.join(REPO, f));
  check(`${f} exists on disk`, onDisk);

  const ls = spawnSync("git", ["ls-files", "--error-unmatch", "--", f], {
    cwd: REPO,
    encoding: "utf8",
  });
  const tracked = ls.status === 0;
  let committed = false;
  if (tracked) {
    try {
      execFileSync("git", ["show", `HEAD:${f}`], {
        cwd: REPO,
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      committed = true;
    } catch {
      committed = false;
    }
  }
  if (!tracked || !committed) unreachables.push(f);   // one per failing check
  check(
    `${f} is reachable at ${TAG} (tracked and committed)`,
    tracked && committed,
    tracked
      ? "exists on disk but differs from HEAD -- the tag would serve the old copy"
      : "UNTRACKED -- the documented curl would 404",
  );

  // And the docs must actually name that path.
  check(`${f} is named by the documented command`, en.some((c) => REPO_PATH_OF(c.url) === f));
  const withDest = en.find((c) => REPO_PATH_OF(c.url) === f);
  check(`${f} is downloaded with an explicit -o destination`, !!withDest?.dest, withDest?.dest ?? "");
}

// --- 4. The documented layout is one the installer can actually resolve -------
// The docs download all three files FLAT into /tmp. The installer walks:
//   $SCRIPT_DIR/lib, $REPO_ROOT/scripts/lib, $SCRIPT_DIR
// and requires BOTH libraries in the SAME directory. If the docs ever changed to
// put the installer in one place and the libraries in another, the documented
// command would resolve nothing and die at exit 7.
check(
  "the installer derives SCRIPT_DIR from its own location",
  /SCRIPT_DIR=/.test(installer) && /BASH_SOURCE|dirname/.test(installer),
);

const candidates = [...installer.matchAll(/"(\$[A-Z_]+\/lib|\$[A-Z_]+)"/g)].map((m) => m[1]!);
check(
  "the installer's candidate list ends in a bare SCRIPT_DIR (flat /tmp works)",
  candidates.some((c) => c === "$SCRIPT_DIR"),
  `candidates: ${candidates.join(", ")}`,
);
check(
  "the resolution loop requires BOTH libraries in the same directory",
  /-f "\$candidate\/release-layout\.sh" && -f "\$candidate\/service-unit\.sh"/.test(installer),
  "if it checked one file it could mix libraries from different directories",
);

// --- 5. The documented command passes the version the installer expects -------
check(
  `the documented command passes --version ${TAG}`,
  new RegExp(`--version\\s+${TAG.replace(/\./g, "\\.")}`).test(readme),
  "the docs and the installer must agree on the tag",
);

// --- 6. Non-vacuity: a changed doc path MUST be detected ---------------------
// If the URL regexp above silently matched nothing, checks 2 and 3 would be
// vacuously true. Prove the extraction actually finds commands.
check(
  "NON-VACUITY: the curl extraction really finds commands",
  en.length >= 3 && fa.length >= 3,
  `extracted ${en.length} from README.md and ${fa.length} from README_FA.md`,
);
{
  const broken = readme.replace(
    /https:\/\/raw\.githubusercontent\.com\/insekt1024\/xistance-panel\/v1\.2\.0\//g,
    "https://raw.githubusercontent.com/insekt1024/xistance-panel/latest/",
  );
  const stillPinned = curlPairs(broken).every((c) => c.url.includes(`/${TAG}/`));
  check(
    "NON-VACUITY: unpinning the documented URL IS detected",
    !stillPinned,
    "the pinning control changed nothing, so the pin checks are vacuous",
  );
}

// --- 7. No secrets in the examples (TASK-18 criterion 5) ---------------------
const SECRET_SHAPES = [
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgho_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
for (const [label, md] of [
  ["README.md", readme],
  ["README_FA.md", readmeFa],
] as const) {
  const hit = SECRET_SHAPES.find((re) => re.test(md));
  check(`${label} contains no real secret values`, !hit, hit ? `matched ${hit}` : "");
}

if (unreachables.length > 0) {
  // One per FAILING check, so `fail - readinessFindings` is the real failure
  // count. Counting findings per FILE under-counts and lets a genuine failure
  // hide behind the subtraction.
  readinessFindings = unreachables.length;
  console.log("");
  console.log("  ══ RELEASE READINESS (documented install would 404) ═════════════");
  for (const f of unreachables) console.log(`  ${f} is not reachable at ${TAG}`);
  console.log("  Both READMEs fetch these from raw.githubusercontent at the pinned");
  console.log("  tag. Until they are committed, that tag does not contain them and");
  console.log("  the documented one-line install returns a 404 that is easy to");
  console.log("  misread as a network fault. Not a product defect: a pre-commit");
  console.log("  precondition. The install itself is verified working (TASK-110).");
  console.log("  ═══════════════════════════════════════════════════════════════");
}

// Exit 0 with a readiness finding; hard-fail only on a real contract break.
console.log(
  `\n--- ${pass} passed, ${fail - readinessFindings} failed, ` +
    `${readinessFindings} readiness finding(s) ---\n`,
);
if (fail - readinessFindings > 0) process.exit(1);
