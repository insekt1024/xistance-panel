/**
 * TASK-114 — dashboard text legibility: measured, not assumed.
 *
 * The report this closes was that dashboard spacing, text sizing and element
 * sizes are wrong, some text is unreadable, and some wraps badly — in BOTH
 * dashboards. That is a legibility complaint, which is a different class from an
 * overflow complaint, and the repository had no coverage for it:
 *
 *   - test-a11y-* suites: 1 `scrollWidth`/`clientWidth` assertion total
 *   - viewport matrix:   NONE — no narrow-viewport rendering at all
 *   - the one browser suite with RTL support checks horizontal overflow only,
 *     never whether a label fits the box it was given
 *
 * So a dashboard could pass every suite while shipping unreadable text. This
 * measures it.
 *
 * METHOD (the important part)
 * --------------------------
 * Measuring a rendered box tells you the height of the CAP, not the height of
 * the CONTENT. A label that is truncated at one line measures exactly one line,
 * so `scrollHeight <= clientHeight` certifies the truncation as fitting — the
 * defect certifies itself. Every assertion here therefore measures the
 * REQUIREMENT: re-render the same string with no clamp, in the same box, and
 * compare. A clamped label and an unclamped label are compared against each
 * other, never against themselves.
 *
 * What it reports per element:
 *   - `truncated`      content needs more lines than the element allows
 *   - `clipped`        the element's own box is smaller than its text's natural height
 *   - `tooSmall`       rendered font-size below the legibility floor
 *   - `tightWrap`      more wrapped lines than the character count justifies
 *
 * Non-vacuity: a deliberately damaged copy of the page must turn this red. If the
 * scan finds nothing to measure, the suite says so and fails.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pickPort } from "./lib/pick-port";

/**
 * Exit 77 means the browser could not run at all. That is NOT a pass — it is a
 * platform-blocked result, reported separately from a green run.
 */
const EXIT_BROWSER_UNAVAILABLE = 77;

const REPO = path.resolve(import.meta.dirname, "..");
const APP = path.join(REPO, "apps/web");

/** Font sizes below this are unreadable regardless of what fits. */
const LEGIBILITY_FLOOR_PX = 11;

/**
 * A string needs at least one line per ~CUT_CHARS_PER_LINE characters at a normal
 * column width. Needing many more than that means the column is too narrow and
 * the text is breaking after a word or two.
 */
const CUT_CHARS_PER_LINE = 18;

/**
 * The narrowest phone in the matrix. 320 is the classic budget width and the one
 * that exposes cramped columns; wider widths must not be allowed to mask it.
 */
const VIEWPORTS = [
  { w: 320, h: 720, label: "320 (narrow budget)" },
  { w: 390, h: 844, label: "390 (modern phone)" },
  { w: 768, h: 1024, label: "768 (tablet)" },
];

interface Browser {
  newContext(opts?: Record<string, unknown>): Promise<Context>;
  close(): Promise<void>;
}
interface Context {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Page {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  setViewportSize(v: { width: number; height: number }): Promise<void>;
  evaluate<T>(fn: string | ((...a: never[]) => T), arg?: unknown): Promise<T>;
  click(s: string): Promise<void>;
  fill(s: string, v: string): Promise<void>;
  waitForSelector(s: string, o?: Record<string, unknown>): Promise<void>;
  content(): Promise<string>;
  on(ev: string, cb: (...a: unknown[]) => void): void;
}

let pass = 0;
let fail = 0;
let skipped = 0;
let lastLoginFailure = "";
let lastScrollExcluded = 0;
const failures: string[] = [];

function ok(name: string): void {
  pass++;
  console.log(`  ok   ${name}`);
}
function bad(name: string, detail: string): void {
  fail++;
  failures.push(name);
  console.log(`  \u2717 ${name}`);
  console.log(`       ${detail}`);
}
function skip(name: string, why: string): void {
  skipped++;
  console.log(`  --   ${name} (${why})`);
}

// ---------------------------------------------------------------------------
// Static pre-check: the constructs that CAUSE legibility defects
// ---------------------------------------------------------------------------
console.log("Source guards — the constructs that shrink or clamp text");

/**
 * `@tailwindcss/line-clamp-N` or `line-clamp-N` CSS truncates text after N lines.
 * Legitimate on a description; never on a label that says what a number MEANS.
 * The guard therefore reports them, and the browser measurement below decides
 * whether any of them actually clip.
 */
function scanSource(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      scanSource(p, out);
    } else if (/\.tsx?$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const sources = scanSource(path.join(APP, "app")).concat(
  scanSource(path.join(APP, "src")),
);

/**
 * `FittedBox`-equivalent in web CSS: `font-size` computed to fit, or a transform
 * scale on a text node. Both answer "too wide" by making the text SMALLER, so the
 * value renders below the legibility floor and gets smaller the harder the user
 * strains. The fix belongs at the call site, in the value's format.
 */
const SHRINK_TO_FIT =
  /text-\[clamp\(|text-\[min\(|font-size\s*:\s*min\(|scale-\[0\.\d+\]\s*(?![^<]*icon)/;

const shrinkHits: string[] = [];
for (const f of sources) {
  const src = fs.readFileSync(f, "utf8");
  if (SHRINK_TO_FIT.test(src)) shrinkHits.push(path.relative(REPO, f));
}
if (shrinkHits.length === 0) {
  ok("no shrink-to-fit text sizing in the app tree");
} else {
  bad(
    "no shrink-to-fit text sizing in the app tree",
    `${shrinkHits.length} file(s): ${shrinkHits.slice(0, 3).join(", ")}`,
  );
}

/**
 * A hand-tuned fixed height beside text is the shape that survives a text-style
 * change and then overflows by a pixel at every scale. Flag fixed pixel heights
 * on elements that also contain text, in the dashboard and card components.
 */
const DASHBOARD_TEXT_FILES = sources.filter((f) =>
  /(dashboard|stat|card|responsive-table|kpi)/i.test(path.basename(f)),
);
ok(
  `scanned ${DASHBOARD_TEXT_FILES.length} dashboard/card source file(s) for text sizing`,
);

// ---------------------------------------------------------------------------
// Browser measurement
// ---------------------------------------------------------------------------
let browser: Browser | null = null;
let server: ChildProcess | null = null;
let devServerUrl = "";

/**
 * playwright-core is NOT a project dependency: it lives in the npx cache the
 * browser download was registered against. A bare `require("playwright")`
 * throws, which would make this suite skip itself as UNVERIFIED forever -- so
 * resolve it the way test-a11y-browser.ts does, across the npx cache roots.
 */
function resolvePlaywright(): unknown | null {
  // Each path must be reachable on the host that runs the suite. The first two
  // are Windows shapes -- on a Linux runner they never exist, so the resolver
  // returned null and the suite printed
  //   browser measurement SKIPPED (no playwright resolvable)
  // while exiting green. Chromium was installed on that runner and still went
  // unused, because nothing looked where Linux puts playwright.
  const home = os.homedir();
  const candidates = [
    // This repository's own dependency tree -- the normal case on any platform.
    path.join(process.cwd(), "node_modules"),
    // Linux: the npx cache and the browser binaries.
    path.join(home, ".npm/_npx"),
    path.join(home, ".cache/ms-playwright"),
    // Windows shapes, kept because this suite also runs here.
    path.join(home, "AppData/Local/npm-cache/_npx"),
    path.join(home, "AppData/Local/ms-playwright"),
    path.join(home, "node_modules"),
  ];
  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    // Both npx caches (.npm/_npx on Linux, AppData/Local/npm-cache/_npx on
    // Windows) hold one directory per package rather than the package itself.
    const roots = base.endsWith("_npx") && fs.statSync(base).isDirectory()
      ? fs.readdirSync(base).map((d) => path.join(base, d, "node_modules"))
      : [base];
    for (const root of roots) {
      const q = path.join(root, "playwright-core");
      if (!fs.existsSync(q)) continue;
      try {
        return createRequire(import.meta.url ?? __filename)(q);
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/**
 * This host has an OLDER cached chromium than playwright-core expects, so the
 * binary must be found explicitly. Without this the launch demands a ~150 MB
 * download -- and if none is present, say UNVERIFIED rather than quietly pass.
 */
function findChromium(): string | null {
  // Playwright puts browsers in a different place per platform. On Linux that
  // is ~/.cache/ms-playwright, which the old Windows-only path never found --
  // so even with playwright-core resolved, no browser binary existed to launch.
  const home = os.homedir();
  const cache = [
    path.join(home, ".cache/ms-playwright"),
    path.join(home, "AppData/Local/ms-playwright"),
    path.join(home, "Library/Caches/ms-playwright"),
  ].find((c) => fs.existsSync(c));
  if (!cache) return null;
  const dirs = fs.readdirSync(cache).filter((d) => d.startsWith("chromium")).sort().reverse();
  const rel =
    process.platform === "win32"
      ? ["chrome-win64/chrome.exe"]
      : process.platform === "darwin"
        ? ["chrome-mac/Chromium.app/Contents/MacOS/Chromium"]
        : ["chrome-linux/chrome"];
  for (const d of dirs) {
    for (const r of rel) {
      const p = path.join(cache, d, r);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Mirrors test-a11y-browser.ts exactly, because it is the only arrangement on
 * this host that actually starts the app: a throwaway SQLite database migrated
 * with the SAME apply-migrations.mjs the installer uses, placeholder-only
 * secrets, and a disposable admin to sign in with.
 *
 * Using the Prisma CLI here instead would test a different code path than
 * production, which is the reason the proven suite avoids it.
 */
async function startServer(): Promise<{ ok: boolean; dbPath: string; email: string; password: string; serverLog: string }> {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-legibility-"));
  const dataDir = path.join(TMP, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  // Absolute, forward-slashed, and derived from Node's own view of the path.
  // A Windows path pasted into a `file:` URL keeps its BACKSLASHES, which makes
  // it an invalid URL, and Prisma then resolves it against its own cwd --
  // creating a DIFFERENT database from the one the migrations just wrote. The
  // server still boots (it creates an empty DB on connect) and health returns
  // 200, so the failure surfaces much later as a 500 on login.
  const dbPath = path.join(dataDir, "legibility.db");
  const dbUrl = `file:${path.resolve(dbPath).split(path.sep).join("/")}`;
  const env = {
    ...process.env,
    DATABASE_URL: dbUrl,
    XT_DATA_DIR: dataDir,
    XT_BIN_DIR: path.join(dataDir, "bin"),
    NODE_ENV: "production",
    // Placeholder-only secrets. Never a real value.
    XTENC_KEY: "0".repeat(64),
    JWT_SECRET: "1".repeat(64),
    XT_TRUST_PROXY: "false",
  };

  const mig = spawnSync(
    process.execPath,
    [path.join(REPO, "scripts/apply-migrations.mjs"), "--database", dbPath],
    { encoding: "utf8" },
  );
  if (mig.status !== 0) {
    console.log(`  --   apply-migrations failed: ${(mig.stderr || mig.stdout || "").slice(0, 200)}`);
    return { ok: false, dbPath, email: "", password: "", serverLog };
  }

  const port = await pickPort();
  // `next start`, from apps/web -- exactly what test-a11y-browser.ts does, and
  // PROVEN to serve a working login on this host. The standalone entrypoint is
  // the one that SHIPS, and it is exercised for real against both target OSes by
  // test-target-runs-shipped-payload.ts, so the shipping path is not left
  // unverified by measuring the dashboard here.
  const nextBin = path.join(REPO, "node_modules/next/dist/bin/next");
  server = spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
    cwd: path.join(REPO, "apps/web"),
    env: { ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let serverLog = "";
  server.stdout?.on("data", (c: Buffer) => {
    serverLog += c.toString();
  });
  server.stderr?.on("data", (c: Buffer) => {
    serverLog += c.toString();
  });
  devServerUrl = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const r = await fetch(`${devServerUrl}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      server.kill("SIGTERM");
      return { ok: false, dbPath, email: "", password: "", serverLog };
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  // The database must EXIST and be non-empty before the admin is created. A
  // 0-byte file means the server is about to read a different database than the
  // one that was migrated.
  {
    const st = fs.statSync(dbPath);
    if (st.size === 0) {
      console.log(`  --   the migrated database is 0 bytes at ${dbPath} -- the server would read a different file`);
      server.kill("SIGTERM");
      return { ok: false, dbPath, email: "", password: "", serverLog };
    }
  }

  const email = `legibility-${Date.now()}@example.invalid`;
  const password = "Legibility-Probe-Password-1";
  const admin = spawnSync(
    process.execPath,
    [
      path.join(REPO, "scripts/create-admin.mjs"),
      "--database", dbPath,
      "--email", email,
      "--password", password,
    ],
    { encoding: "utf8" },
  );
  if (admin.status !== 0) return { ok: false, dbPath, email, password, serverLog };
  return { ok: true, dbPath, email, password, serverLog };
}

/**
 * Sign in with the disposable admin, because the dashboard is authenticated --
 * measuring the login page would measure the wrong screen entirely.
 */
/**
 * Runs in the page. Measures every visible text-bearing element.
 *
 * THE LOAD-BEARING PART is the truncation test, and it deliberately does NOT
 * read `scrollHeight`. For a clamped element that reports the CLAMPED height and
 * therefore CONFIRMS the defect -- a truncated label certifies itself as fitting.
 *
 * So instead: clone the element, strip the clamp, measure the clone's natural
 * height at the SAME width, and compare that requirement against the lines the
 * real box allows. A clamped label and its unclamped twin are compared to each
 * other, never to themselves.
 */
const MEASURE = `(() => {
  const out = { elements: [], scanned: 0, svgText: 0, chartText: 0, inScrollCtx: 0 };
  const els = document.querySelectorAll(
    'p,span,div,h1,h2,h3,h4,h5,h6,label,dt,dd,td,th,li,a,button,legend,figcaption'
  );
  OUTER: for (const el of els) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;

    // Anything inside a recharts chart is library-drawn, not a dashboard label:
    // axis ticks are SVG, and the Tooltip is a transient overlay. Both are sized
    // by the library, not by the layout, so neither is a wrapping-label surface.
    // Checked over the WHOLE ancestor chain -- the marker sits on the chart
    // wrapper, several levels above the text node.
    for (let n = el; n; n = n.parentElement) {
      const cn = typeof n.className === 'string' ? n.className : '';
      const id = typeof n.id === 'string' ? n.id : '';
      if (/recharts-wrapper|recharts-surface/i.test(cn) ||
          /^recharts[-_]/.test(id)) { out.chartText++; continue OUTER; }
    }

    // SVG text (recharts axis ticks, its empty state) is not a wrapping label.
    // It has no line box -- getBoundingClientRect returns the glyph box -- and
    // the probe clone is an HTML element laid out at a different width, so every
    // line count derived from it is meaningless. Exclude, and count the exclusion.
    const inSvg = el.ownerSVGElement || el.closest('svg');
    if (inSvg) { out.svgText++; continue; }

    if (parseFloat(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 4) continue;

    // Only DIRECT text, so a container is not measured as its own child's text.
    const direct = Array.from(el.childNodes)
      .filter(n => n.nodeType === 3)
      .map(n => n.textContent.trim())
      .join(' ')
      .trim();
    if (direct.length < 2) continue;

    // Inside a horizontally scrollable ancestor, a NON-WRAPPING element that
    // spills is the DESIGNED behaviour: the table grows and the user scrolls,
    // which is what a nowrap class inside a scrollable table is FOR.
    //
    // A WRAPPING element is still measured, and that is the distinction that
    // matters. A cell that wraps a 43-character name into six lines inside an
    // 82px column is a defect -- the cell shrank instead of the table growing --
    // and excusing it because an ancestor scrolls hides exactly that. It was
    // excusing it: reverting the node-name fix and the activity-row fix each left
    // this suite green, so those two fixes were unverified.
    //
    // Scoping the exclusion to non-wrapping elements keeps the correct cells
    // green AND makes a shredded identifier fail again.
    let inScrollCtx = false;
    for (let n = el.parentElement, d = 0; n && d < 12; n = n.parentElement, d++) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') { inScrollCtx = true; break; }
    }
    const wraps = cs.whiteSpace !== 'nowrap' && cs.whiteSpace !== 'pre';
    const selfHides =
      (cs.textOverflow === 'ellipsis' &&
        (cs.overflowX === 'hidden' || cs.overflowX === 'clip' ||
         cs.overflowX === 'auto' || cs.overflowX === 'scroll')) ||
      (cs.webkitLineClamp !== 'none' && parseInt(cs.webkitLineClamp || '0', 10) > 0);
    if (inScrollCtx && !wraps && !selfHides) { out.inScrollCtx++; continue OUTER; }

    out.scanned++;
    const fs = parseFloat(cs.fontSize);
    const lh = cs.lineHeight === 'normal' ? fs * 1.2 : parseFloat(cs.lineHeight);

    // Natural height of this string with NO clamp, at the same width.
    const probe = el.cloneNode(true);
    // Remove the CLAMP ONLY. Do NOT touch white-space: forcing it to 'normal'
    // measures a whitespace:nowrap link as though it wrapped, which invents a
    // truncation that the page does not have. (It did: the footer version link
    // was reported "needs 3 lines" while carrying ws=nowrap and shrink=0.)
    // Strip the clamp, and strip every CONSTRAINT that would make this measure
    // the CONTAINER rather than the text.
    //
    // Three separate mistakes lived in these three lines:
    //
    // 1. Forcing white-space:normal undid a legitimate whitespace:nowrap, so
    //    the footer version link measured as 3 lines while carrying ws=nowrap.
    //    white-space is therefore NOT touched here.
    //
    // 2. Copying a FIXED height into the clone meant "natural height" described
    //    the box. h-56 on the traffic-chart empty state produced "No traffic
    //    yet needs 11 lines in a 14px box" -- impossible, and the reported
    //    ancestry named the cause.
    //
    // 3. Leaving display:flex on the clone means the text is laid out as a flex
    //    line box, not a block, so its height is not a multiple of line-height.
    //
    // Width IS carried over -- it is what wrapping depends on. Everything else
    // that could cap or inflate the box is reset, and display:block makes the
    // measured height an exact multiple of the line-height.
    probe.style.cssText +=
      ';max-height:none;height:auto;min-height:0;' +
      '-webkit-line-clamp:unset;line-clamp:unset;' +
      'overflow:visible;padding:0;margin:0;border:0;' +
      'min-width:0;max-width:none;position:static;float:none;' +
      'align-items:flex-start;align-self:auto;justify-self:auto;' +
      'display:block;';
    probe.style.width = r.width + 'px';
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;visibility:hidden;left:-9999px;' +
      'width:' + r.width + 'px;';
    host.appendChild(probe);
    document.body.appendChild(host);
    const pr = probe.getBoundingClientRect();
    const probeH = pr.height;
    const probeW = pr.width;
    const pcs = getComputedStyle(probe);
    const probeFs = parseFloat(pcs.fontSize) || 0;
    const probeLh = pcs.lineHeight === 'normal' ? 0 : parseFloat(pcs.lineHeight);
    host.remove();

    // Each height is divided by ITS OWN line-height. Using one divisor for both
    // is how a 238px-wide one-line label came to "need 11 lines".
    const linesAllowed = Math.max(1, Math.round(r.height / (lh || fs * 1.2)));
    const linesNeeded = Math.max(
      1,
      Math.round(probeH / (probeLh || probeFs * 1.2 || lh || fs * 1.2)),
    );

    out.elements.push({
      text: direct.slice(0, 70),
      tag: el.tagName.toLowerCase(),
      cls: (el.className && String(el.className).slice(0, 60)) || '',
      fontSize: fs,
      lineHeight: lh,
      boxW: Math.round(r.width),
      boxH: Math.round(r.height),
      contentH: Math.round(probeH),
      linesAllowed,
      linesNeeded,
      probeW: Math.round(probeW),
      probeFs,
      probeLh,
      chars: direct.length,
      // Report the styles that decide wrapping, so any "needs N lines" claim can
      // be checked against what the browser actually applied.
      whiteSpace: cs.whiteSpace,
      wordBreak: cs.wordBreak,
      overflowWrap: cs.overflowWrap,
      flexShrink: cs.flexShrink,
      display: cs.display,
      canWrap: cs.whiteSpace !== 'nowrap' && cs.whiteSpace !== 'pre',
      // A TRUNCATED element is SUPPOSED to overflow internally: that overflow is
      // what the ellipsis hides. A truncate class is nowrap + overflow:hidden +
      // text-overflow:ellipsis, so scrollW > boxW is its normal, correct state.
      // An element that overflows WITHOUT either an ellipsis or a scrollable
      // ancestor really does spill, and that stays a failure.
      // Require the HORIZONTAL axis only. CSS normalises an overflow-x of hidden
      // with an overflow-y of visible into overflow-y:auto, so demanding hidden on
      // BOTH axes rejects a perfectly good truncate -- and this suite then
      // reported 4 failures for an element that was truncating correctly. The
      // ellipsis applies along x; that is the axis that matters.
      // Whether the truncate class is actually on this element. The ellipsis
      // property alone can be INHERITED from a parent, which would make an
      // element look like it truncates when it does not.
      truncatesBy: (el.className && typeof el.className === 'string'
        ? /(^|\s)truncate(\s|$)/.test(el.className)
        : false),
      selfTruncates:
        cs.textOverflow === 'ellipsis' &&
        (cs.overflowX === 'hidden' || cs.overflowX === 'clip' ||
         cs.overflowX === 'auto' || cs.overflowX === 'scroll'),
      clamped: cs.webkitLineClamp !== 'none' && parseInt(cs.webkitLineClamp || '0', 10) > 0,
      scrollW: el.scrollWidth,
      // Ancestry, so a label can be traced to a component. Several reported
      // defects turned out to be chart internals or library defaults, and the
      // fastest way to settle that is the chain of class names, not a grep.
      path: (() => {
        const parts = [];
        let n = el;
        for (let d = 0; n && d < 4; d++, n = n.parentElement) {
          parts.push(n.tagName.toLowerCase() +
            (n.className && typeof n.className === 'string' && n.className
              ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.')
              : ''));
        }
        return parts.join(' < ');
      })(),
      overflowX: el.scrollWidth - el.clientWidth,
    });
  }
  out.total = els.length;
  return out;
})()`;

interface Measured {
  text: string;
  tag: string;
  cls: string;
  whiteSpace: string;
  wordBreak: string;
  overflowWrap: string;
  flexShrink: string;
  display: string;
  canWrap: boolean;
  truncatesBy: boolean;
  scrollW: number;
  path: string;
  route: string;
  fontSize: number;
  boxW: number;
  boxH: number;
  contentH: number;
  linesAllowed: number;
  linesNeeded: number;
  probeW: number;
  probeFs: number;
  probeLh: number;
  chars: number;
  selfTruncates: boolean;
  clamped: boolean;
  overflowX: number;
}

/**
 * A comment inside the MEASURE template literal that contains a backtick or an
 * unbalanced apostrophe silently TERMINATES the literal. That happened three
 * times here, each presenting as an unrelated esbuild "Expected \";\" but found
 * X" error with no hint that a comment was the cause.
 *
 * So it is checked, not remembered.
 */
function assertTemplateLiteralIsIntact(): void {
  // `MEASURE` is the template's VALUE, so it contains no delimiters. If a stray
  // backtick in a comment had terminated the literal early, the value would have
  // been TRUNCATED -- which is exactly what is checked here.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const start = src.indexOf("const MEASURE = `");
  const end = src.indexOf("\n})()`;", start);
  if (start < 0 || end < 0) {
    bad(
      "the page-side MEASURE script is a single intact template literal",
      "could not locate its delimiters in the source",
    );
    return;
  }
  const inner = src.slice(start, end);
  if (inner.slice("const MEASURE = `".length).includes("`")) {
    bad(
      "the page-side MEASURE script is a single intact template literal",
      "a comment inside it contains a backtick, which ends the literal early",
    );
    return;
  }
  // And the value itself must still be a complete IIFE, not a fragment.
  if (!MEASURE.trim().startsWith("(() =>") || !MEASURE.trim().endsWith("})()")) {
    bad(
      "the page-side MEASURE script is a single intact template literal",
      "the value is truncated -- it no longer opens and closes as an IIFE",
    );
    return;
  }
  ok("the page-side MEASURE script is a single intact template literal");
}

async function signIn(page: Page, email: string, password: string): Promise<boolean> {
  await page.goto(`${devServerUrl}/en/login`, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector('input[type="email"]', { timeout: 30_000 });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    // Wait for the URL CONCURRENTLY with the click. Clicking first and polling
    // afterwards loses the race: the navigation can complete before the first
    // poll, and a 250ms-interval poll then reads a page that already moved --
    // or, on a slow first paint, reports "still on login" for a form that worked.
    await Promise.all([
      page.waitForURL((u: URL) => !u.pathname.endsWith("/login"), { timeout: 30_000 }),
      page.click('button[type="submit"]'),
    ]);
    return true;
  } catch (e) {
    const where = (await page.evaluate("location.pathname")) as string;
    const body = (await page
      .evaluate("(document.body.innerText || '').slice(0, 200)")
      .catch(() => "")) as string;
    lastLoginFailure = `${(e as Error).message.slice(0, 80)} | ended on ${where} | page says: ${body.replace(/\s+/g, " ").slice(0, 140)}`;
    return false;
  }
}

/**
 * Seed rows with the LONGEST realistic values, so table cells are measured under
 * the pressure that actually breaks them.
 *
 * Every route was previously rendered against an EMPTY database, so what was
 * measured was empty states. A cell holding a 38-character tunnel name, a
 * long-hostname node, or a 40-character API key is a completely different layout
 * problem -- and it is the case a user meets first.
 *
 * Values are long but REALISTIC, not adversarial: a FQDN with a long subdomain
 * chain, an SSH user with a full address, a name a human actually typed. The
 * point is to find the cell that gives up under realistic load, not to prove the
 * renderer can be broken.
 *
 * Seeded through the REAL API with the schema's own field names (`sshPort`,
 * `sshUser`), because a probe using the wrong names fails validation and seeds
 * nothing -- which looks exactly like "the page has no data".
 */
async function seedRealisticData(page: Page): Promise<{ ok: boolean; detail: string }> {
  // Long but REALISTIC: a FQDN with a real subdomain chain, a name a human
  // actually typed, a 80-char URL at the schema's own limit. The point is the
  // cell that gives up under realistic load, not to break the renderer.
  //
  // Field names come from the ROUTE validators, not the Prisma model. They
  // differ: the API takes `port`/`username` (NodeConfigSchema, which is spliced
  // into an ssh destination token), while the model column is `sshPort`/`sshUser`.
  // Guessing from the schema produced four 422s and an EMPTY database that still
  // reported a green seed.
  const results: string[] = [];

  const post = async (path: string, body: unknown): Promise<string> => {
    const r = await page.evaluate(
      async ([p, b]) => {
        const m = document.cookie.match(/(?:^|;\s*)xt_csrf=([^;]+)/);
        const csrf = m ? decodeURIComponent(m[1]!) : "";
        const res = await fetch(p as string, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(csrf ? { "X-CSRF-Token": csrf } : {}),
          },
          body: JSON.stringify(b),
        });
        return `${res.status} ${(await res.text()).slice(0, 100)}`;
      },
      [path, body] as unknown[],
    );
    results.push(`${path} -> ${r}`);
    return r;
  };

  const NODE_A = "Frankfurt Edge Gateway Primary Cluster Node";
  const NODE_B = "Tehran Secondary Data Centre Node";
  const HOST_A = "edge-gateway-01.eu-central-1.fra.internal.example.net";
  const HOST_B = "tehran-dc-02.prod.example.net";
  const TUNNEL = "Frankfurt to Tehran Production Replication Link";

  await post("/api/nodes", {
    name: NODE_A,
    type: "FOREIGN",
    host: HOST_A,
    port: 22,
    username: "deploy",
    authMethod: "key",
  });
  await post("/api/nodes", {
    name: NODE_B,
    type: "IRAN",
    host: HOST_B,
    port: 2222,
    username: "root",
    authMethod: "key",
  });

  // Tunnels and port-forwards need real node ids, so read them back.
  const ids = await page.evaluate(
    `fetch('/api/nodes', { headers: { 'X-CSRF-Token': '' } })
       .then(r => r.json()).then(j => (j.items || j.data || j).map(n => n.id))
       .catch(() => [])`,
  ) as string[];
  results.push(`/api/nodes list -> ${ids.length} id(s)`);

  if (ids.length >= 2) {
    await post("/api/tunnels", {
      name: TUNNEL,
      clientNodeId: ids[0],
      serverNodeId: ids[1],
      config: {
        method: "BACKHAUL",
        backhaul: {
          localPort: 22,
          remoteHost: HOST_B,
          remotePort: 22,
          autoReconnect: true,
        },
      },
      autostart: false,
    });
    await post("/api/port-forwards", {
      name: "Frankfurt Reverse Tunnel PostgreSQL Replication",
      sourcePort: 5432,
      destHost: HOST_B,
      destPort: 15432,
      nodeId: ids[0],
      enabled: true,
      auto: false,
    });
  }

  await post("/api/webhooks", {
    name: "Ops Alerting Webhook Destination Endpoint",
    type: "discord",
    url: "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
    events: ["tunnel.start", "tunnel.stop"],
    enabled: true,
  });

  const rejected = results.filter((r) => /-> (4\d\d|5\d\d)/.test(r));
  return { ok: rejected.length === 0, detail: results.join(" | ") };
}

/**
 * WCAG 1.4.4 -- text must stay usable at 200% of its default size.
 *
 * Emulated by setting the ROOT font-size, which is what a browser's text-size
 * setting and a page zoom do to a rem-based layout. This suite is mostly rem-based
 * classes (169 vs 3 px-based), so root scaling is the honest lever.
 *
 * At 200% every label needs roughly twice the lines. A layout that only fits at
 * 100% is not broken -- it is just unusable for the people the criterion exists
 * to protect, and that is exactly the "unreadable text" report.
 */
const TEXT_SCALES = [1, 1.5, 2];

/**
 * Every authenticated view. Not just the dashboard: a truncated label, a
 * sub-floor caption, or a starved column is the same defect wherever it sits,
 * and nine routes had no coverage at all.
 *
 * `tunnels/new` is included; the tunnel wizard is the densest form in the app.
 */
const ROUTES = [
  { path: "", label: "dashboard" },
  { path: "tunnels", label: "tunnels" },
  { path: "tunnels/new", label: "tunnels/new" },
  { path: "nodes", label: "nodes" },
  { path: "port-forward", label: "port-forward" },
  { path: "users", label: "users" },
  { path: "users/activity", label: "users/activity" },
  { path: "webhooks", label: "webhooks" },
  { path: "audit", label: "audit" },
  { path: "settings", label: "settings" },
  { path: "tools", label: "tools" },
];

async function scanDashboard(
  page: Page,
  locale: string,
  route = "",
  textScale = 1,
): Promise<Measured[]> {
  const url = `${devServerUrl}/${locale}/${route}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("body");
  // Applied AFTER load so hydration does not reset it, and re-asserted before the
  // scan because the app can rewrite the root element.
  // Playwright evaluates a string as an EXPRESSION, so a bare assignment
  // statement parses as a truncated expression ("Unexpected end of input").
  await page.evaluate(
    `(() => { document.documentElement.style.fontSize = '${textScale * 100}%'; return true; })()`,
  );
  // Let fonts settle: a measurement taken before webfonts load reads fallback
  // metrics, which is how a legibility suite certifies numbers that are not the
  // ones the user sees.
  await page.evaluate(`(async () => {
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch {} }
    await new Promise(r => setTimeout(r, 1200));
  })()`);
  const res = (await page.evaluate(MEASURE)) as {
    elements: Measured[];
    scanned: number;
    inScrollCtx: number;
  };
  lastScrollExcluded = res.inScrollCtx;
  for (const e of res.elements) e.route = route || "dashboard";
  return res.elements;
}

async function main(): Promise<void> {
  const pw = resolvePlaywright();
  if (!pw) {
    console.log("");
    console.log("  --   browser measurement SKIPPED (no playwright resolvable)");
    console.log("");
    console.log(
      `--- ${pass} passed, ${fail} failed, ${skipped} skipped ---\n` +
        `--- SOURCE GUARDS ONLY: ${skipped > 0 ? "not a full verification" : "complete"} ---\n`,
    );
    process.exit(EXIT_BROWSER_UNAVAILABLE);
  }

  assertTemplateLiteralIsIntact();

  const started = await startServer();
  if (!started.ok) {
    console.log("");
    console.log("  --   browser measurement SKIPPED (the app did not start)");
    if ((started.serverLog ?? "").trim()) {
      for (const l of started.serverLog.trim().split(/\r?\n/).slice(0, 10)) {
        console.log(`       ${l.slice(0, 160)}`);
      }
    }
    console.log(`--- ${pass} passed, ${fail} failed, ${skipped} skipped ---\n`);
    console.log("--- SOURCE GUARDS ONLY: not a full verification ---\n");
    process.exit(EXIT_BROWSER_UNAVAILABLE);
  }

  const pwAny = pw as {
    chromium: {
      launch(o: Record<string, unknown>): Promise<Browser>;
    };
  };
  const exe = findChromium();
  try {
    browser = await pwAny.chromium.launch({
      headless: true,
      ...(exe ? { executablePath: exe } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (e) {
    console.log(`  --   browser measurement SKIPPED (chromium could not launch: ${(e as Error).message.slice(0, 90)})`);
    console.log(`--- ${pass} passed, ${fail} failed, ${skipped} skipped ---\n`);
    console.log("--- SOURCE GUARDS ONLY: not a full verification ---\n");
    process.exit(EXIT_BROWSER_UNAVAILABLE);
  }

  for (const locale of ["en", "fa"]) {
    console.log("");
    console.log(`Dashboard text fit — ${locale} (${locale === "fa" ? "RTL" : "LTR"})`);

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const authPage = await context.newPage();
    if (!(await signIn(authPage, started.email, started.password))) {
      bad(
        `${locale}: the disposable admin can sign in`,
        `still on the login page after submitting (${started.email}): ${lastLoginFailure}`,
      );
      await context.close();
      continue;
    }
    ok(`${locale}: the disposable admin can sign in`);

    if (locale === "en") {
      const seeded = await seedRealisticData(authPage);
      if (seeded.ok) {
        ok(`seeded realistic long values: ${seeded.detail.slice(0, 160)}`);
      } else {
        // Every table below is measured EMPTY, so the whole legibility run is
        // vacuous. That must be a failure, not a note.
        bad(
          "realistic long values were seeded for the tables",
          `a write was rejected, so the tables are empty and every table measurement below is vacuous: ${seeded.detail.slice(0, 220)}`,
        );
      }
    }

    for (const route of ROUTES) {
      for (const vp of VIEWPORTS) {
        // The full matrix runs at 100%. At 200% the narrowest viewport is the
        // WCAG worst case -- the tightest column holding the largest text -- so
        // that plus one mid width is where a defect would show, without paying
        // for a third of the browser time on a case that rarely differs.
        const scales: number[] =
          vp.w === VIEWPORTS[0]!.w
            ? TEXT_SCALES
            : TEXT_SCALES.slice(0, 1);
        for (const scale of scales) {
        const page = await context.newPage();
        await page.setViewportSize({ width: vp.w, height: vp.h });
        const els = await scanDashboard(page, locale, route.path, scale);
        await page.close();

        const where =
          scale === 1
            ? `${locale} ${route.label} @ ${vp.w}px`
            : `${locale} ${route.label} @ ${vp.w}px @${Math.round(scale * 100)}% text`;
        if (lastScrollExcluded > 0) {
          // Never silent: a growing exclusion is how a real defect goes unseen.
          ok(
            `${where}: ${lastScrollExcluded} element(s) excluded -- inside a horizontally scrollable container, where overflow is the designed behaviour`,
          );
        }
        if (els.length === 0) {
          bad(
            `${where}: text elements were measurable`,
            "found none -- the scan is not seeing the page, so every check below is vacuous",
          );
          continue;
        }

        // An element is truncated when it needs MORE lines than its box allows.
        // The tolerance is one rendered line: the element's box may include
        // padding and a border that the stripped probe does not, so the two line
        // counts can differ by one at the boundary. "Needs 1, allows 1" is not a
        // defect and must not be reported as one.
        const truncated = els.filter((e) => {
          if (e.canWrap) return e.linesNeeded - e.linesAllowed > 1;
          // A nowrap element whose own ellipsis hides the overflow is CORRECT:
          // the internal overflow is the mechanism, not the symptom. It is a
          // candidate only when nothing clips it -- no self-truncation and no
          // scrollable ancestor -- so the spill is actually visible.
          if (e.selfTruncates || e.clamped) return false;
          return e.scrollW > e.boxW + 2;
        });
        if (truncated.length === 0) {
          ok(`${where}: no label is truncated (${els.length} measured)`);
        } else {
          bad(
            `${where}: no label is truncated (${els.length} measured)`,
            truncated
              .slice(0, 3)
              .map(
                (e) =>
                  `"${e.text}" needs ${e.linesNeeded}, allows ${e.linesAllowed} ` +
                  `[box ${e.boxW}x${e.boxH} scrollW ${e.scrollW} canWrap=${e.canWrap} ` +
                  `selfTrunc=${e.selfTruncates} hasTruncateClass=${e.truncatesBy} ` +
                  `ws=${e.whiteSpace}]`,
              )
              .join(" | "),
          );
        }

        const clipped = els.filter(
          (e) => e.canWrap && e.linesNeeded - e.linesAllowed > 1,
        );
        if (clipped.length === 0) {
          ok(`${where}: no element clips its own text`);
        } else {
          bad(
            `${where}: no element clips its own text`,
            clipped
              .slice(0, 3)
              .map((e) => `"${e.text}" content ${e.contentH}px in a ${e.boxH}px box`)
              .join(" | "),
          );
        }

        const BY_DESIGN = (e: Measured): boolean => {
          if (/recharts|chart|axis|tick|legend|tooltip/i.test(e.cls)) return true;
          if (/recharts-tooltip-wrapper|recharts-default-tooltip/i.test(e.path)) return true;
          if (/\u2299|\u21b5|\u2318|\u2325|\u238b/i.test(e.text)) return true;
          if (/^(?:ctrl|alt|shift|cmd|meta|esc|tab|enter)[+\s]/i.test(e.text.trim())) return true;
          return false;
        };
        // The floor applies at the DEFAULT size. At a larger user text scale the
        // text is already bigger by request, so the effective floor scales with it.
        const floor = LEGIBILITY_FLOOR_PX / scale;
        const tinyAll = els.filter((e) => e.fontSize < floor);
        const tiny = tinyAll.filter((e) => !BY_DESIGN(e));
        if (tinyAll.length !== tiny.length) {
          ok(
            `${where}: ${tinyAll.length - tiny.length} sub-floor label(s) are by-design (chart ticks / key hints)`,
          );
        }
        if (tiny.length === 0) {
          ok(`${where}: no text below the ${floor.toFixed(1)}px legibility floor`);
        } else {
          bad(
            `${where}: no text below the ${floor.toFixed(1)}px legibility floor`,
            tiny.slice(0, 3).map((e) => `"${e.text}" at ${e.fontSize}px`).join(" | "),
          );
        }

        // Characters per line scale inversely with the user text scale: the same
        // column holds roughly half as many at 200%. Without this, a label that
        // legitimately needs three lines in a 110px column at 200% is reported as
        // wrapping far earlier than its length warrants -- when the real situation
        // is large text in a narrow box, which is correct.
        const cut = CUT_CHARS_PER_LINE / scale;
        const tight = els.filter(
          (e) =>
            !BY_DESIGN(e) &&
            e.canWrap &&
            e.linesNeeded > Math.ceil(e.chars / cut) + 1 &&
            e.chars >= 12,
        );
        if (tight.length === 0) {
          ok(`${where}: no label wraps far earlier than its length warrants`);
        } else {
          bad(
            `${where}: no label wraps far earlier than its length warrants`,
            tight
              .slice(0, 3)
              .map(
                (e) =>
                  `"${e.text}" (${e.chars} chars) needs ${e.linesNeeded} lines ` +
                  `[${e.probeW}px] :: ${e.path}`,
              )
              .join(" | "),
          );
        }

        // Overflow that is NOT hidden by an ellipsis and NOT inside a scroll
        // container really does spill into the layout.
        const hOver = els.filter((e) => e.overflowX > 2 && !e.selfTruncates && !e.clamped);
        const truncating = els.filter((e) => e.selfTruncates || e.clamped);
        if (truncating.length > 0) {
          ok(
            `${where}: ${truncating.length} long value(s) truncate with an ellipsis (value still in the DOM and in the accessible name)`,
          );
        }
        if (hOver.length === 0) {
          ok(`${where}: no text spills out of its box horizontally`);
        } else {
          bad(
            `${where}: no text spills out of its box horizontally`,
            hOver
              .slice(0, 3)
              .map((e) => `"${e.text}" overflows by ${e.overflowX}px (ws=${e.whiteSpace})`)
              .join(" | "),
          );
        }
        }
      }
    }

    await authPage.close();
    await context.close();
  }

  // ---------------------------------------------------------------------
  // Non-vacuity: a damaged dashboard MUST turn this red.
  //
  // Inject a text-clamp + a sub-floor font size, re-scan, and require that the
  // scan reports them. If it does not, every measurement above is blind.
  // ---------------------------------------------------------------------
  console.log("");
  console.log("NON-VACUITY — an injected defect must be detected");
  {
    const b = browser;
    const context = await b?.newContext({ viewport: { width: 390, height: 844 } });
    if (context) {
      const page = await context.newPage();
      await page.goto(`${devServerUrl}/en`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("body");
      const injected = (await page.evaluate(`
        (() => {
          const d = document.createElement('div');
          d.id = 'legibility-probe';
          d.textContent = 'A deliberately very long label that must be truncated by the injected clamp';
          d.style.cssText = 'width:120px;font-size:9px;line-height:1;z-index:2147483647;' +
            '-webkit-line-clamp:1;overflow:hidden;position:fixed;left:0;top:0;' +
            'padding:0;margin:0;border:0;';
          document.body.appendChild(d);
          return document.body.contains(d);
        })()
      `)) as boolean;
      if (!injected) {
        bad(
          "the injected probe is actually in the DOM",
          "the page removed it, so the non-vacuity check cannot work",
        );
      } else {
        ok("the injected probe is actually in the DOM");
      }
      const res = (await page.evaluate(MEASURE)) as { elements: Measured[] };
      const probe = res.elements.find((e) => e.text.includes("deliberately very long"));
      if (!probe) {
        bad(
          "an injected clamped, 9px label is detected as truncated/too small",
          "the scan did not report the injected probe, so its assertions are blind",
        );
      } else {
        const detected =
          probe.linesNeeded > probe.linesAllowed || probe.fontSize < LEGIBILITY_FLOOR_PX;
        if (detected) {
          ok(
            `an injected clamped, 9px label is detected (needs ${probe.linesNeeded} lines in ${probe.linesAllowed}, ${probe.fontSize}px)`,
          );
        } else {
          bad(
            "an injected clamped, 9px label is detected as truncated/too small",
            `scan reported ${probe.linesNeeded}/${probe.linesAllowed} lines at ${probe.fontSize}px — it cannot see the defect`,
          );
        }
      }
      await context.close();
    } else {
      skip("an injected clamped, 9px label is detected", "browser unavailable");
    }
  }

  await browser?.close();
  browser = null;

  console.log(`\n--- ${pass} passed, ${fail} failed, ${skipped} skipped ---\n`);
  process.exit(fail > 0 ? 1 : 0);
}

let threw: unknown = null;

main()
  .catch((e: unknown) => {
    // A crash is a FAILURE. Reporting it and exiting 0 would let a broken scan
    // read as a clean run -- the exact false-pass this suite exists to prevent.
    threw = e;
    console.error("  ✗ the legibility scan threw:", e instanceof Error ? e.message : e);
    if (e instanceof Error && e.stack) {
      for (const l of e.stack.split(/\r?\n/).slice(1, 4)) console.error(`       ${l.trim()}`);
    }
    fail++;
  })
  .finally(async () => {
    try {
      await browser?.close();
    } catch {
      /* already gone */
    }
    if (server && !server.killed) {
      // Kill ONLY the process this suite spawned.
      //
      // `taskkill /T` walks the whole process TREE rooted at that pid. That is how
      // this suite took down the Docker engine's port-bound helpers, which exited
      // BOTH Ubuntu target containers mid-aggregate and made two unrelated suites
      // report "target is unreachable". A test must never take down infrastructure
      // it does not own.
      //
      // `detached: true` puts the child in its own group, and `taskkill` WITHOUT
      // `/T` terminates only the named pid.
      server.kill("SIGTERM");
      const r = spawnSync(process.platform === "win32" ? "taskkill" : "kill", [
        ...(process.platform === "win32"
          ? ["/pid", String(server.pid), "/F"]
          : ["-TERM", String(server.pid)]),
      ]);
      void r;
    }
  });

if (threw) {
  console.log(`\n--- ABORTED: the scan threw, so this is NOT a pass ---\n`);
  process.exit(1);
}
if (failures.length > 0) {
  console.log("  failing: " + failures.join("; "));
}
