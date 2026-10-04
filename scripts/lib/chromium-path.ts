/**
 * Locate a usable Chromium/Chrome executable for the browser suites.
 *
 * This exists because seven copies of the same platform-path guess had drifted
 * apart, and the guess was wrong for a modern Playwright install on Linux:
 *
 *   1. `npx playwright install chromium` now writes TWO directories:
 *      `chromium-<rev>/` (full browser) and `chromium_headless_shell-<rev>/`.
 *      Filtering on `startsWith("chromium")` matches BOTH, and
 *      `sort().reverse()` puts the headless shell FIRST, because `_` sorts after
 *      `-` in ASCII.
 *   2. The full browser ships `chrome-linux/chrome`, but the headless shell ships
 *      `chrome-linux/headless_shell`. A resolver that only ever probes
 *      `chrome-linux/chrome` therefore misses whichever directory it lands in,
 *      and on a clean Linux runner it returned null: the suite printed
 *      "SKIP: playwright/chromium unavailable" and exited 77 while Chromium was
 *      installed and fully usable.
 *
 * So this does not GUESS a path. It walks the cache and returns the first
 * executable that actually exists, newest revision first, checking every known
 * layout per directory. `executablePath` is optional for Playwright anyway --
 * when it resolves its own browser, callers should omit it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Playwright's per-platform browser cache. */
export function playwrightCacheDir(): string {
  // PLAYWRIGHT_BROWSERS_PATH is Playwright's own override and wins over every
  // platform default. Honouring it is what makes this resolver agree with the
  // binary the suite would otherwise have launched.
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && fs.existsSync(override)) return override;
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "ms-playwright");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ms-playwright");
}

/** Executable layouts seen across Playwright versions, newest naming first. */
function layouts(dir: string): string[] {
  const base = path.basename(dir);
  // A headless-shell build is preferred: it is what `playwright install chromium`
  // is optimized for, and it is the binary Playwright itself launches headless.
  if (/chromium_headless_shell/i.test(base)) {
    return [
      "chrome-linux/headless_shell",
      "chrome-mac/headless_shell",
      "chrome-win/headless_shell.exe",
    ];
  }
  return [
    "chrome-linux/chrome",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-win/chrome.exe",
    "chrome-win64/chrome.exe",
  ];
}

/**
 * The newest revision number present, so a stale cached build never wins over a
 * fresh one. Non-numeric suffixes sort below numeric ones.
 */
function revision(dir: string): number {
  const m = /(\d+)\s*$/.exec(dir);
  return m ? Number(m[1]) : -1;
}

/**
 * The first Chromium executable that actually exists, or null.
 * Returning null is honest: callers must SKIP loudly rather than pretend.
 */
export function findChromiumExecutable(): string | null {
  const cache = playwrightCacheDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cache, { withFileTypes: true });
  } catch {
    return null; // no cache directory at all
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("chromium"))
    .map((e) => e.name)
    // Newest revision first, then full browser before headless shell, so a
    // full-browser build is preferred when both exist at the same revision.
    .sort((a, b) => revision(b) - revision(a) || a.localeCompare(b));

  for (const d of dirs) {
    for (const rel of layouts(path.join(cache, d))) {
      const p = path.join(cache, d, rel);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}
