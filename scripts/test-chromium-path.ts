// Proves scripts/lib/chromium-path.ts finds a real executable across every
// directory layout Playwright has shipped -- including the two-directory layout
// that made every browser suite SKIP on a clean Linux CI runner.
//
// The bug it guards: `npx playwright install chromium` now writes BOTH
//   chromium-<rev>/                  -> chrome-linux/chrome
//   chromium_headless_shell-<rev>/    -> chrome-linux/headless_shell
// The old resolver filtered on startsWith("chromium"), sorted descending (so the
// headless shell came FIRST, because `_` > `-`), and then probed only
// chrome-linux/chrome. It returned null and every suite reported
// "playwright/chromium unavailable" while Chromium was installed and usable.
//
// This builds synthetic caches in a temp dir and asserts the resolver returns
// the correct binary for each, including when BOTH directories are present and
// when the headless shell sorts first.

import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChromiumExecutable } from "./lib/chromium-path";

/** Write a cache with the given <dir>/<rel> files, return its path. */
function makeCache(files: Record<string, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), "chromium-path-"));  // os.tmpdir() is NATIVE on Windows
  for (const [dir, rels] of Object.entries(files)) {
    for (const rel of rels) {
      const p = join(root, dir, ...rel.split("/"));
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "stub");
    }
  }
  return root;
}

const LINUX_FULL = "chrome-linux/chrome";
const LINUX_SHELL = "chrome-linux/headless_shell";

// Each case lists the layouts to create. The resolver is layout-agnostic by
// design, so assertions check that it returned A real file from the RIGHT
// directory, not that it returned one specific OS-specific path.
const FULL = "chrome-linux/chrome";
const SHELL = "chrome-linux/headless_shell";

const cases: { name: string; files: Record<string, string[]>; wantDir: string | null }[] = [
  { name: "full chromium only (the original layout)", files: { "chromium-1100": [FULL] }, wantDir: "chromium-1100" },
  { name: "headless shell only", files: { "chromium_headless_shell-1100": [SHELL] }, wantDir: "chromium_headless_shell-1100" },
  {
    // The exact CI failure: both directories exist, and the shell sorts FIRST
    // under a descending sort because '_' > '-'. The old resolver then probed
    // only chrome-linux/chrome, missed both, and SKIPped.
    name: "BOTH present, shell sorts first -- the CI failure",
    files: { "chromium-1100": [FULL], "chromium_headless_shell-1100": [SHELL] },
    wantDir: "chromium_headless_shell-1100",
  },
  {
    name: "the NEWEST revision is chosen",
    files: { "chromium-1100": [FULL], "chromium-1140": [FULL] },
    wantDir: "chromium-1140",
  },
  { name: "an empty cache finds nothing", files: {}, wantDir: null },
  { name: "an unrelated directory is ignored", files: { "ffmpeg-1011": ["ffmpeg"] }, wantDir: null },
];

let pass = 0, fail = 0;

for (const c of cases) {
  const cache = makeCache(c.files);
  try {
    // Exercise the REAL resolver in-process. A child process cannot be used here:
    // each case needs a different PLAYWRIGHT_BROWSERS_PATH, and on Windows a
    // POSIX temp path is invisible to native node (so the override silently
    // resolves to the real cache and every case "passes" for the wrong reason).
    process.env.PLAYWRIGHT_BROWSERS_PATH = cache;
    const found = findChromiumExecutable();

    const ok = c.wantDir === null
      ? found === null
      : found !== null && found.includes(c.wantDir) && fs.existsSync(found);
    if (ok) { pass++; console.log(`  ok   ${c.name}${found ? ` -> ${found.split(/[\\/]/).slice(-3).join("/")}` : ""}`); }
    else { fail++; console.log(`  FAIL ${c.name}: found=${found} want=${c.want}`); }

  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("RESULT: FAIL"); process.exit(1); }
console.log("RESULT: PASS");
