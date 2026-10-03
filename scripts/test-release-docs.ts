/**
 * Documentation contract check (TASK-18).
 *
 * The README is the only thing a user reads before installing, so a command
 * that disagrees with the installer is a real defect: it sends people to a
 * flag that does not exist, or to a build step the release deliberately
 * removed. This check extracts the documented install command and holds it
 * against the actual installer surface.
 *
 * It is written to fail against the current documentation, so a passing run
 * means the docs were changed rather than the check being weakened.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), "utf8");

const readme = read("README.md");
const readmeFa = read("README_FA.md");
const installer = read("scripts/release-install.sh");

const failures: string[] = [];
const check = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};

// ---------------------------------------------------------------------------
// 1. The documented release install command must exist and be version-pinned.
// ---------------------------------------------------------------------------
// Fenced blocks may be indented or inside a blockquote, so the fence is
// matched with optional leading decoration rather than at column zero.
const installBlocks = [...readme.matchAll(/^[ \t>]*(?:```|~~~)(?:bash|sh|console)?\s*\n([\s\S]*?)^[ \t>]*(?:```|~~~)/gm)]
  .map((m) => m[1])
  .filter((block) => block.includes("release-install.sh"));

check(
  installBlocks.length > 0,
  "README.md must document a release-install.sh command in a bash code block",
);

for (const block of installBlocks) {
  check(
    /--version\s+v?\d+\.\d+\.\d+/.test(block),
    `the documented install must pin an exact version tag, found:\n${block.trim()}`,
  );
  check(
    !/--version\s+latest\b/.test(block),
    "the documented install must not use an unpinned 'latest' tag",
  );
  check(
    !/\bnpm\s+(ci|install)\b/.test(block),
    "the documented install must not run npm on the target host",
  );
  check(
    !/\b(next\s+build|npm\s+run\s+build|prisma\s+generate)\b/.test(block),
    "the documented install must not tell the host to build source",
  );
}

// ---------------------------------------------------------------------------
// 1b. The documented tag must be the version the code actually is.
//
// This section existed to catch a flag that does not exist or a build step the
// release removed. It never asked whether the pinned TAG is real: the docs
// hard-code `v1.2.0` in 15 install commands while package.json and version.ts
// still said 1.1.2, and every check passed — because `--version v\d+\.\d+\.\d+`
// only asserts the SHAPE of a tag, and `version:check` only compares the seven
// manifests to each other. Nothing in the repo tied the documentation to the
// code, so "1.2.0" was an aspiration written into install instructions.
//
// The consequence is concrete: a reader who follows README.md verbatim fetches
// release-install.sh from the v1.2.0 REF on GitHub, and that tag does not
// exist. Every documented install command 404s.
const pkgVersion = (JSON.parse(read("package.json")) as { version: string }).version;
const versionTs = /export const APP_VERSION = "([^"]+)"/.exec(read("apps/web/src/lib/version.ts"))?.[1] ?? "";

check(
  versionTs === pkgVersion,
  `package.json says ${pkgVersion} but version.ts says ${versionTs || "(unreadable)"}`,
);

// Collect every tag the docs tell a reader to install, from BOTH languages, and
// require them all to be the one this tree is. Scoped to the places a tag is
// actually consumed: `--version <tag>` and the raw.githubusercontent ref, which
// is a fetch against a ref that must exist. Not every "v1.2.0" string in a
// README is a claim about this release.
for (const [label, doc] of [
  ["README.md", readme],
  ["README_FA.md", readmeFa],
] as const) {
  const installTags = new Set<string>();
  for (const m of doc.matchAll(/--version\s+(v?\d+\.\d+\.\d+)/g)) installTags.add(m[1].replace(/^v/, ""));
  for (const m of doc.matchAll(/xistance-panel\/(v\d+\.\d+\.\d+)\//g)) installTags.add(m[1].replace(/^v/, ""));
  for (const m of doc.matchAll(/xistance-panel-(v\d+\.\d+\.\d+)-/g)) installTags.add(m[1].replace(/^v/, ""));

  check(
    installTags.size > 0,
    `${label} must document at least one pinned release tag to install`,
  );
  for (const tag of installTags) {
    // Name the tag the DOCS pin, not the one the code has — otherwise the
    // message reads "install v1.1.2 but this tree is 1.1.2", which is
    // self-contradictory and tells the reader nothing about the drift.
    check(
      tag === pkgVersion,
      `${label} tells readers to install v${tag}, but this tree is ${pkgVersion}; ` +
        `the raw.githubusercontent fetch for the v${tag} ref would 404`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1c. The staged manifest must not be a stale artifact of an earlier version.
//
// `stage-release-artifact.ts` COPIES `<repo>/release-manifest.json` into the
// payload rather than generating one — the same file the release workflow
// writes just before staging. That is correct in CI, where the file is written
// three lines earlier. It is a trap locally: `release-manifest.json` is
// untracked build output, so a copy left over from an earlier run is picked up
// silently and the payload ships a manifest naming a version the code no longer
// is. That is exactly what happened during the 1.2.0 cutover — the staged
// manifest still said 1.1.2 with `xistance-panel-1.1.2-amd64.tar.gz`, and every
// other check passed.
//
// CI regenerates the manifest immediately before staging, so requiring the
// committed tree's version to equal the manifest's is the property that actually
// holds. Absent manifest is not a failure: CI creates it as part of staging, and
// a tree that has never staged has nothing to be stale about.
const manifestPath = path.join(repoRoot, "release-manifest.json");
if (existsSync(manifestPath)) {
  const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    version?: string;
    releaseTag?: string;
    artifact?: { name?: string };
  };
  check(
    m.version === pkgVersion,
    `release-manifest.json declares version ${m.version ?? "(none)"} but the tree is ${pkgVersion}; ` +
      `regenerate it (release-manifest.ts build) before staging, or the payload ships a stale manifest`,
  );
  check(
    m.releaseTag === `v${pkgVersion}`,
    `release-manifest.json declares releaseTag ${m.releaseTag ?? "(none)"}, expected v${pkgVersion}`,
  );
  check(
    m.artifact?.name?.includes(pkgVersion) ?? false,
    `release-manifest.json names artifact ${m.artifact?.name ?? "(none)"}, which does not carry version ${pkgVersion}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Every installer flag the docs mention must actually exist in the script.
// ---------------------------------------------------------------------------
// Every long option passed to the INSTALLER must be one it accepts.
// Collecting an allowlist and validating only that would make an invented flag
// invisible, which is exactly the defect this check exists to catch.
//
// Scoped to lines that actually invoke release-install.sh: the docs also pass
// flags to create-admin.mjs, bootstrap.sh and git, and those are validated by
// their own scripts rather than here.
const installerFlagLines = readme
  .split("\n")
  .filter((line) => line.includes("release-install.sh") && line.includes("--"));
const documentedFlags = new Set<string>();
for (const line of installerFlagLines) {
  for (const m of line.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)) {
    documentedFlags.add(m[1]);
  }
}
check(documentedFlags.size > 0, "README.md must pass at least one flag to release-install.sh");
for (const flag of documentedFlags) {
  const accepted = new RegExp(`${flag}[=)\\s]`, "m").test(installer);
  check(
    accepted,
    `README.md passes ${flag} to release-install.sh, which does not accept it`,
  );
}

// ---------------------------------------------------------------------------
// 3. Prerequisite separation: runtime vs artifact vs tunnel binaries.
// ---------------------------------------------------------------------------
check(
  /node(\.js)?\s*22/i.test(readme),
  "README.md must state the Node.js runtime prerequisite (Node.js 22)",
);
check(
  /tunnel/i.test(readme) && /binar(y|ies)|bin\//i.test(readme),
  "README.md must distinguish tunnel binaries from the application artifact",
);
check(
  /amd64/i.test(readme) && /arm64/i.test(readme),
  "README.md must document the supported architectures",
);
check(
  /22\.04/.test(readme) && /24\.04/.test(readme),
  "README.md must document the supported Ubuntu releases",
);

// ---------------------------------------------------------------------------
// 4. Operational model: static assets, immutability, cutover, backup, rollback.
// ---------------------------------------------------------------------------
for (const [label, pattern] of [
  ["static assets", /static assets|\.next\/static/i],
  ["versioned release directories", /releases\/v\d|\/releases\b/i],
  ["atomic cutover", /atomic/i],
  ["health check", /health/i],
  ["rollback", /rollback|roll back/i],
  ["backup", /backup/i],
  ["checksum", /sha256|checksum/i],
] as const) {
  check(pattern.test(readme), `README.md must document ${label}`);
}

// ---------------------------------------------------------------------------
// 5. No real secret values, and no stale source-build instructions.
// ---------------------------------------------------------------------------
for (const [name, doc] of [["README.md", readme], ["README_FA.md", readmeFa]] as const) {
  const secretish = doc.match(/(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9!@#$%^&*_.-]{8,}/gi) ?? [];
  for (const hit of secretish) {
    const looksLikePlaceholder = /example|placeholder|your[-_ ]|changeme|<|\$\{|xxx|redacted|\*\*|YOUR_/i.test(hit);
    check(
      looksLikePlaceholder,
      `${name} appears to contain a literal secret value: ${hit.slice(0, 60)}`,
    );
  }
}

// The docs may mention a source build for developers, but never as the
// production install path.
for (const [name, doc] of [["README.md", readme], ["README_FA.md", readmeFa]] as const) {
  const prodSection = doc.slice(doc.search(/## (Install|نصب)/i));
  check(
    !/npm\s+ci\s*&&\s*npm\s+run\s+build/.test(prodSection),
    `${name} must not present a source build as the production install`,
  );
}

// ---------------------------------------------------------------------------
// 6. The Persian README must mirror the same release contract.
// ---------------------------------------------------------------------------
check(
  /release-install\.sh/.test(readmeFa),
  "README_FA.md must document the same release-install.sh command",
);
check(
  /--version\s+v?\d+\.\d+\.\d+/.test(readmeFa),
  "README_FA.md must pin an exact version tag",
);
for (const [label, pattern] of [
  ["checksum", /sha256|checksum|جمع‌چین/i],
  ["rollback", /rollback|بازگردان|بازگشت/i],
  ["architectures", /amd64/i],
  // Persian prose may write the version with Persian digits (۲۲), so both
  // numeral forms are accepted.
  ["Node.js 22", /22|۲۲/],
] as const) {
  check(pattern.test(readmeFa), `README_FA.md must document ${label}`);
}

// The same pinned version in both languages, so the two READMEs agree.
const enTag = readme.match(/--version\s+(v?\d+\.\d+\.\d+)/)?.[1];
const faTag = readmeFa.match(/--version\s+(v?\d+\.\d+\.\d+)/)?.[1];
check(
  Boolean(enTag) && enTag === faTag,
  `README.md and README_FA.md must document the same version tag (en=${enTag}, fa=${faTag})`,
);

// ---------------------------------------------------------------------------
// 7. No duplicated prose. A paragraph repeated verbatim (an editing accident
//    from a copy-paste or a bad merge) renders as a visible stutter in the
//    rendered README and is invisible to every other check here, because the
//    duplicated text still satisfies each individual requirement.
// ---------------------------------------------------------------------------
for (const [label, doc] of [
  ["README.md", readme],
  ["README_FA.md", readmeFa],
] as const) {
  // Compare non-empty prose lines, ignoring fenced code and the exact repeats
  // that are legitimate. Two kinds are legitimate and must not fail:
  //   * a command line that appears in more than one place by design (the
  //     bootstrap curl is shown in the recommended path AND the source-build
  //     path; the pinned install command is shown in the one-liner AND under
  //     "Updating"), and
  //   * table rows, which carry distinct cells but share a prefix.
  // What must never be duplicated is *prose*: a wrapped paragraph, where the
  // repetition is a rendering stutter rather than a command.
  const prose = doc
    .split("\n")
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(
      ({ line }) =>
        line.length >= 40 &&
        !line.startsWith("|") &&
        !line.startsWith("#") &&
        // A shell prompt, a URL, or a flag means this is an instruction the
        // reader is meant to run, not narrative prose.
        !/\b(sudo|curl|bash|npx|node|npm|echo|systemctl|tar|sha256sum|gh)\b/.test(line) &&
        !/https?:\/\//.test(line) &&
        !/^\s*--[a-z]/.test(line),
    );
  const seen = new Map<string, number[]>();
  for (const { line, index } of prose) {
    const hits = seen.get(line);
    if (hits) hits.push(index);
    else seen.set(line, [index]);
  }
  for (const [line, indexes] of seen) {
    if (indexes.length > 1) {
      check(
        false,
        `${label} repeats the same sentence on lines ${indexes
          .map((i) => i + 1)
          .join(", ")}: "${line.slice(0, 70)}…"`,
      );
    }
  }
  // Also catch a duplicated multi-line paragraph even when no single line is
  // itself long enough to be a sentence. Same scoping: a paragraph that is
  // entirely commands is legitimately repeated, prose is not.
  const paras = doc
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(
      (p) =>
        p.length >= 80 &&
        !p.startsWith("|") &&
        !p.startsWith("#") &&
        !p.startsWith("```") &&
        !p.split("\n").every((l) => /\b(sudo|curl|bash|npx|node|npm|echo|systemctl|tar)\b/.test(l) || /https?:\/\//.test(l)),
    );
  const paraSeen = new Set<string>();
  for (const p of paras) {
    if (paraSeen.has(p)) {
      check(false, `${label} contains a duplicated paragraph: "${p.slice(0, 70)}…"`);
    }
    paraSeen.add(p);
  }
}

if (failures.length > 0) {
  console.error(`\n❌ Documentation contract: ${failures.length} problem(s)\n`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("");
  process.exit(1);
}

console.log("✅ Documentation contract: install command, flags, prerequisites, operations, and both languages agree");
