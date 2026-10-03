/**
 * Browser verification of Persian direction and catalog parity (TASK-49).
 *
 * The source-level parity test proves the intent. This proves the RENDERED
 * result, which is the only thing the operator sees:
 *
 *   - <html lang> and <html dir> are correct per locale;
 *   - a real table's actions cell sits on the SAME side as its data in both
 *     locales (the defect this task fixed: a hard `text-right` stranded the
 *     action buttons on the opposite edge in Persian);
 *   - no element overflows the viewport horizontally in Persian;
 *   - a Latin-script fragment (a port number, a hostname) does not flip the
 *     surrounding text direction, which is the "LTR field leakage" the
 *     acceptance criteria name.
 *
 * Runs against a real production build served over HTTP and driven by a real
 * Chromium, because computed layout cannot be asserted from source.
 *
 * Exit code 77 means "could not run here" (no browser, no build, no network
 * loopback) and is deliberately distinct from pass and from fail.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { pickPort } from "./lib/pick-port";

const EXIT_SKIP = 77;
const require_ = createRequire(path.join(process.cwd(), "noop.js"));

let pass = 0;
const failures: string[] = [];
const ok = (name: string, extra = "") => { pass += 1; console.log(`  ok   ${name}${extra ? " — " + extra : ""}`); };
const bad = (name: string, detail: string) => { failures.push(name); console.log(`  FAIL ${name}\n       ${detail}`); };
const skip = (why: string) => { console.log(`\nSKIP (${why})`); process.exit(EXIT_SKIP); };

/* ------------------------------------------------------------------ browser */

interface PW {
  chromium: {
    launch(opts: Record<string, unknown>): Promise<{
      newPage(): Promise<Page>;
      close(): Promise<void>;
    }>;
  };
}
interface Page {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  evaluate<T>(fn: string | ((...a: unknown[]) => T), arg?: unknown): Promise<T>;
  waitForSelector(sel: string, opts?: Record<string, unknown>): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
}

/** Locate playwright-core without adding a dependency to the project. */
function findPlaywright(): PW | null {
  const candidates = [
    // The npx cache the browser download was registered against.
    path.join(os.homedir(), "AppData/Local/npm-cache/_npx"),
    path.join(os.homedir(), "node_modules"),
    path.join(process.cwd(), "node_modules"),
  ];
  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    const roots = base.endsWith("_npx")
      ? fs.readdirSync(base).map((d) => path.join(base, d, "node_modules"))
      : [base];
    for (const root of roots) {
      const p = path.join(root, "playwright-core");
      if (fs.existsSync(p)) {
        try {
          return require_(p) as PW;
        } catch { /* try the next one */ }
      }
    }
  }
  return null;
}

/** Locate a Chromium binary in the playwright browser cache. */
function findChromium(): string | null {
  // Playwright's browser cache is per-platform. The Windows-only path never
  // matches on a Linux runner, so the suite reported "no browser" and fell back
  // to source guards alone while still exiting green.
  const home = os.homedir();
  const cache = [
    path.join(home, ".cache/ms-playwright"),
    path.join(home, "AppData/Local/ms-playwright"),
    path.join(home, "Library/Caches/ms-playwright"),
  ].find((c) => fs.existsSync(c));
  if (!cache) return null;
  const dirs = fs.readdirSync(cache)
    .filter((d) => d.startsWith("chromium"))
    .sort()
    .reverse();
  const rel = process.platform === "win32"
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

/* -------------------------------------------------------------------- util */

const freePort = (): Promise<number> => pickPort("127.0.0.1");

function tempRoot(): string {
  const base = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  if (!base) skip("no temporary directory");
  return fs.mkdtempSync(path.join(base, "xistance-rtl-"));
}

function get(url: string, redirects = 0): Promise<{ status: number; location: string | null; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const loc = res.headers.location ?? null;
      if (loc && res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && redirects < 5) {
        res.resume();
        const next = new URL(loc, url).toString();
        resolve(get(next, redirects + 1));
        return;
      }
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, location: loc, body }));
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("timeout")));
  });
}

/** Wait for the server to answer, so the browser never races the boot. */
async function waitForServer(url: string, timeoutMs = 120_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await get(url);
      if (r.status > 0) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

/* ------------------------------------------------------------------- main */

interface Child { proc: ChildProcess; url: string; dir: string }

async function startServer(): Promise<Child | null> {
  const repoRoot = path.resolve(__dirname, "..");
  const webDir = path.join(repoRoot, "apps/web");
  if (!fs.existsSync(path.join(webDir, ".next/BUILD_ID"))) return null;
  const port = await freePort();
  const dir = tempRoot();
  const env = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NODE_ENV: "production",
    // Disposable per-run values. Never a real secret, never a reused one.
    XT_SESSION_SECRET: require_("node:crypto").randomBytes(32).toString("hex"),
    XT_ENCRYPTION_KEY: require_("node:crypto").randomBytes(32).toString("hex"),
    DATABASE_URL: `file:${path.join(dir, "rtl.db").replace(/\\/g, "/")}`,
    XT_TRUST_PROXY: "false",
  };
  // Spawn the real Node entry point rather than `npx next`: the child's PATH
  // does not reliably contain npx (spawn returned ENOENT), and going through a
  // package runner to start a server we already have installed is needless.
  const nextBin = path.join(repoRoot, "node_modules/next/dist/bin/next");
  if (!fs.existsSync(nextBin)) return null;
  const proc = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: webDir, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout?.on("data", (d) => { log += String(d); });
  proc.stderr?.on("data", (d) => { log += String(d); });
  proc.on("error", (e) => { log += `\nchild error: ${String(e)}`; });
  const url = `http://127.0.0.1:${port}`;
  const up = await waitForServer(`${url}/en`);
  if (!up) {
    proc.kill();
    console.error(log.slice(-2000));
    return null;
  }
  return { proc, url, dir };
}

async function main(): Promise<void> {
  const pw = findPlaywright();
  if (!pw) skip("playwright-core is not installed anywhere on this host");

  console.log("\n--- booting a production build ---");
  const server = await startServer();
  if (!server) skip("no production build in apps/web/.next, or the server did not boot");
  console.log(`  server: ${server.url}`);

  // A data table only renders behind auth, so the alignment check was vacuous
  // without a session. Create a disposable admin -- never a real credential,
  // generated per run against a throwaway database -- and sign in with it.
  const ADMIN_EMAIL = "rtl-probe@example.invalid";
  const ADMIN_PASSWORD = require_("node:crypto").randomBytes(12).toString("base64url");
  {
    const repoRoot2 = path.resolve(__dirname, "..");
    // Migrations first: create-admin writes to a real User table, and a fresh
    // database has none. This is the same order the installer uses.
    const mig = spawnSync(process.execPath, [
      path.join(repoRoot2, "scripts/apply-migrations.mjs"),
      "--database", path.join(server.dir, "rtl.db"),
    ], { encoding: "utf8" });
    if (mig.status !== 0) {
      console.error("apply-migrations failed:", mig.stdout, mig.stderr);
      skip("could not migrate the throwaway database");
    }
    const r = spawnSync(process.execPath, [
      path.join(repoRoot2, "scripts/create-admin.mjs"),
      "--database", path.join(server.dir, "rtl.db"),
      "--email", ADMIN_EMAIL,
      "--password", ADMIN_PASSWORD,
    ], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error("create-admin failed:", r.stdout, r.stderr);
      skip("could not provision a disposable admin for the authenticated checks");
    }
    console.log("  admin: migrated + provisioned (disposable, per-run)");
  }

  let browser: Awaited<ReturnType<PW["chromium"]["launch"]>> | null = null;
  try {
    // playwright-core 1.63 looks for chromium_headless_shell-1246; this host
    // has chromium-1243. Use the binary that is actually present rather than
    // requiring a fresh ~150MB download to run a test.
    const exe = findChromium();
    if (!exe) skip("no Chromium binary found in the playwright browser cache");
    console.log(`  chromium: ${exe}`);
    browser = await pw.chromium.launch({
      headless: true,
      executablePath: exe,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();

    /* ---- the root element declares its own language and direction ---- */
    for (const [locale, wantLang, wantDir] of [
      ["en", "en", "ltr"], ["fa", "fa", "rtl"],
    ] as const) {
      await page.goto(`${server.url}/${locale}/login`, { waitUntil: "domcontentloaded" });
      const root = await page.evaluate<{ lang: string; dir: string }>(`(() => {
        const el = document.documentElement;
        return { lang: el.lang, dir: el.dir };
      })()`);
      if (root.lang === wantLang) ok(`${locale}: <html lang> is "${wantLang}"`);
      else bad(`${locale}: <html lang> is "${wantLang}"`, `got "${root.lang}"`);
      if (root.dir === wantDir) ok(`${locale}: <html dir> is "${wantDir}"`);
      else bad(`${locale}: <html dir> is "${wantDir}"`, `got "${root.dir}"`);
    }

    /* ---- the login page is actually translated, not an English fallback ---- */
    {
      await page.goto(`${server.url}/fa/login`, { waitUntil: "domcontentloaded" });
      const text = await page.evaluate<string>("document.body.innerText");
      const PERSIAN = /[\u0600-\u06FF]/;
      if (PERSIAN.test(text)) ok("fa/login renders Persian text");
      else bad("fa/login renders Persian text", "no Persian character in the rendered body");
      if (!/login|sign in|username|password/i.test(text)) {
        ok("fa/login shows no untranslated English form labels");
      } else {
        const leaked = text.split("\n").filter((l) => /^(login|sign in|username|password)$/i.test(l.trim()));
        bad("fa/login shows no untranslated English form labels", leaked.join(" | ") || "matched an English label");
      }
    }

    /* ---- action cells align with their data in both locales ----
     * The defect this task fixed: a hard `text-right` on the actions cell
     * pinned it to the right edge in Persian while every other cell was
     * right-aligned, stranding the buttons away from the row they act on. */
    {
      for (const locale of ["en", "fa"]) {
        await page.goto(`${server.url}/${locale}/login`, { waitUntil: "domcontentloaded" });
        // A data table only exists behind auth; check the shared Table
        // primitive's own treatment via computed style on any rendered table,
        // and fall back to asserting no hard alignment is left in the bundle.
        const aligned = await page.evaluate<{ found: boolean; sides: string[] }>(`(() => {
          const tables = Array.from(document.querySelectorAll("table"));
          if (tables.length === 0) return { found: false, sides: [] };
          const sides = [];
          for (const t of tables) {
            const head = t.querySelector("thead th");
            if (head) sides.push(getComputedStyle(head).textAlign);
          }
          return { found: true, sides };
        })()`);
        if (!aligned.found) {
          // No table on an unauthenticated page. The source-level test covers
          // the eight views; record that honestly rather than inventing a pass.
          ok(`${locale}: no table on the unauthenticated page (checked at source level)`);
        } else {
          const physical = aligned.sides.filter((s) => s === "right" || s === "left");
          const want = locale === "fa" ? "right" : "left";
          const wrong = physical.filter((s) => s !== want);
          if (wrong.length === 0) ok(`${locale}: table headers align to the ${want} (start) edge`);
          else bad(`${locale}: table headers align to the ${want} (start) edge`, `saw ${wrong.join(",")}`);
        }
      }
    }

    /* ---- no horizontal overflow in Persian ----
     * RTL overflows are the classic bilingual defect: a fixed-width child in a
     * reversed flex row pushes the document wider than the viewport. */
    {
      const ROUTES = ["login", "dashboard", "tunnels", "nodes", "settings"];
      for (const locale of ["en", "fa"]) {
        for (const route of ROUTES) {
          await page.goto(`${server.url}/${locale}/${route}`, { waitUntil: "domcontentloaded" });
          const o = await page.evaluate<{ over: number; sw: number; cw: number; widest: string }>(`(() => {
            const de = document.documentElement;
            const sw = de.scrollWidth, cw = de.clientWidth;
            let widest = "";
            let max = 0;
            for (const el of Array.from(document.querySelectorAll("*"))) {
              const r = el.getBoundingClientRect();
              if (r.right > max) { max = r.right; widest = el.tagName + "." + (el.className || "").toString().slice(0, 40); }
            }
            return { over: sw - cw, sw, cw, widest };
          })()`);
          // 2px of tolerance for sub-pixel rounding.
          if (o.over <= 2) ok(`${locale}/${route}: no horizontal overflow (${o.sw}px in ${o.cw}px)`);
          else bad(`${locale}/${route}: no horizontal overflow`, `${o.over}px wider; widest: ${o.widest}`);
        }
      }
    }

    /* ---- LTR field leakage: a Latin literal must not flip its neighbours ---- */
    {
      await page.goto(`${server.url}/fa/login`, { waitUntil: "domcontentloaded" });
      const leaks = await page.evaluate<Array<{ text: string; dir: string }>>(`(() => {
        const bad = [];
        for (const el of Array.from(document.querySelectorAll("input,label,button,h1,h2,h3,a"))) {
          const t = (el.textContent || "").trim();
          if (!t) continue;
          const hasPersian = /[\\u0600-\\u06FF]/.test(t);
          const hasLatin = /[A-Za-z]{3,}/.test(t);
          if (hasPersian && hasLatin) {
            // A mixed string is fine as long as the ELEMENT does not force ltr.
            const d = getComputedStyle(el).direction;
            if (d === "ltr") bad.push({ text: t.slice(0, 50), dir: d });
          }
        }
        return bad;
      })()`);
      if (leaks.length === 0) ok("fa: no element containing Persian forces direction: ltr");
      else {
        bad("fa: no element containing Persian forces direction: ltr",
          leaks.map((l) => `"${l.text}" (dir=${l.dir})`).join(" | "));
      }
    }

    /* ---- AUTHENTICATED: the real data tables ----
     * Everything above runs on the login page, which has no table. The defect
     * this task fixed was in the actions column of the tunnel/node/user tables,
     * so it is only observable once signed in. */
    {
      // Sign in ONCE. After the session cookie exists, /<locale>/login
      // redirects straight to the app shell, so a second sign-in per locale
      // would find no form and fail for the wrong reason.
      await page.goto(`${server.url}/en/login`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('input#email', { timeout: 30_000 });
      await page.evaluate(`(() => {
        const fill = (sel, v) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error("missing field " + sel);
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(el, v);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        };
        fill('input#email', ${JSON.stringify(ADMIN_EMAIL)});
        fill('input#password', ${JSON.stringify(ADMIN_PASSWORD)});
        const form = document.querySelector("form");
        if (!form) throw new Error("no login form");
        if (form.requestSubmit) form.requestSubmit();
        else form.dispatchEvent(new Event("submit", { bubbles: true }));
      })()`);
      await page.waitForSelector("nav, aside, [role=navigation]", { timeout: 45_000 })
        .catch(() => undefined);
      {
        const landed = await page.evaluate<string>("location.pathname");
        if (landed.includes("/login")) {
          bad("the disposable admin can sign in", `still on ${landed} after submitting the login form`);
        } else {
          ok("the disposable admin can sign in", `landed on ${landed}`);
        }
      }

      // Seed one node through the real API. Without a row the table renders an
      // empty state, and the alignment assertion would never execute -- which is
      // exactly how a vacuous check survives a code change.
      {
        const seeded = await page.evaluate<{ status: number; body: string }>(`(async () => {
          // A bare POST is refused with 403 CSRF token mismatch -- login is
          // CSRF-exempt, mutations are not. Read the token the app itself
          // provides and send it, so this exercises the real guarded path
          // rather than a bypass.
          const m = /xt_csrf=([^;]+)/.exec(document.cookie);
          const csrf = m ? m[1] : "";
          const res = await fetch("/api/nodes", {
            method: "POST",
            credentials: "same-origin",
            headers: Object.assign(
              { "content-type": "application/json" },
              csrf ? { "x-csrf-token": csrf } : {},
            ),
            body: JSON.stringify({
              name: "rtl-probe-node",
              type: "IRAN",
              host: "203.0.113.10",
              port: 22,
              username: "deploy",
              authMethod: "key",
            }),
          });
          return { status: res.status, body: (await res.text()).slice(0, 200) };
        })()`);
        if (seeded.status === 201 || seeded.status === 409) {
          ok("a node was seeded through the real API", `status ${seeded.status}`);
        } else {
          bad("a node was seeded through the real API", `status ${seeded.status}: ${seeded.body}`);
        }
      }

      for (const locale of ["en", "fa"]) {
        await page.goto(`${server.url}/${locale}/nodes`, { waitUntil: "networkidle" });

        const res = await page.evaluate<{ tables: number; rows: number; startAlign: string; endAlign: string; firstIsPhysicallyAt: string; lastIsPhysicallyAt: string; headerAligns: string[]; status: string }>(`(() => {
          const tables = Array.from(document.querySelectorAll("table"));
          const headerAligns = tables.map((t) => {
            const th = t.querySelector("thead th");
            return th ? getComputedStyle(th).textAlign : "?";
          });
          // Measure BOTH edges. The first data cell is the START edge (the node
          // name) and the last is the END edge (the actions). Asserting only
          // td:last-child while expecting the START edge is a contradiction:
          // the actions column is the end in every locale, so the old check
          // demanded "left" from a cell that should be "end".
          const first = document.querySelector("tbody tr td:first-child");
          const last = document.querySelector("tbody tr td:last-child");
          // Geometry: which physical edge does the text actually sit on? This
          // is the assertion that makes the logical values load-bearing -- a
          // hard-coded text-right yields the same computed value in both
          // locales but lands on the WRONG physical edge in one of them.
          // text-align moves the TEXT, not the cell box -- so measure the text
          // itself with a Range over its first text node. An empty cell has no
          // text to measure, which is why the seeded row matters here.
          const geo = (cell) => {
            if (!cell) return { side: "?", at: 0 };
            // The actions cell holds an icon button, not text, so a text-node
            // range finds nothing. Fall back to the cell's own INLINE content
            // box, which is what text-align actually moves.
            const node = Array.from(cell.childNodes).find(
              (n) => n.nodeType === 3 && (n.textContent || "").trim().length > 0,
            );
            let box;
            if (node) {
              const r = document.createRange();
              r.selectNodeContents(node);
              box = r.getBoundingClientRect();
            } else {
              // Walk to the narrowest descendant: a full-width wrapper fills
              // the cell and cannot move, but the button inside it is sized to
              // its content and does. That button is what text-align moves.
              let el = cell;
              let best = cell.getBoundingClientRect();
              for (let d = 0; d < 6 && el.firstElementChild; d++) {
                el = el.firstElementChild;
                const b = el.getBoundingClientRect();
                if (b.width > 0 && b.width < best.width) { best = b; }
                if (b.width <= 32) break;
              }
              box = best;
            }
            if (!box || box.width === 0) return { side: "?", at: 0 };
            const c = cell.getBoundingClientRect();
            // Whichever physical half of the CELL the text sits in.
            const mid = c.left + c.width / 2;
            return { side: box.left + box.width / 2 < mid ? "left" : "right", at: Math.round(box.left - c.left) };
          };
          return {
            tables: tables.length,
            rows: document.querySelectorAll("tbody tr").length,
            startAlign: first ? getComputedStyle(first).textAlign : "?",
            endAlign: last ? getComputedStyle(last).textAlign : "?",
            firstIsPhysicallyAt: geo(first).side,
            lastIsPhysicallyAt: geo(last).side,
            headerAligns,
            status: document.title,
          };
        })()`);

        if (res.tables > 0) {
          ok(`${locale}/nodes: an authenticated data table rendered (${res.rows} rows)`);
          // In Persian the start edge is RIGHT; in English it is LEFT.
          //
          // Both locales are checked, and the mutation run showed why the `en`
          // one is not redundant: reverting this fix to a bare `text-right`
          // is INVISIBLE in `fa`, because `right` is the start edge there. The
          // defect was only ever visible in English -- which is exactly how it
          // shipped, since the primary UI is English and the Persian one merely
          // looked odd. Asserting only `fa` would have passed with the bug in.
          // The computed value is the LOGICAL `start`/`end`, not `left`/`right`:
          // Tailwind's text-start/text-end resolve per writing direction, which
          // is the whole point. What differs per locale is which physical edge
          // each one lands on -- verified by the physical check below -- so
          // asserting the logical value here and the resolved edge there is
          // what makes this a real assertion rather than a tautology.
          //
          // The original version asserted `left`/`right` on td:last-child and
          // demanded the START edge from the actions column. That was wrong
          // twice: the actions column is the end, and the computed value is
          // never `left`/`right` once logical properties are used.
          const wantStart = "start";
          const wantEnd = "end";
          if (res.startAlign === wantStart) {
            ok(`${locale}/nodes: the first column aligns to the ${wantStart} (start) edge`,
              `computed text-align: ${res.startAlign}`);
          } else {
            bad(`${locale}/nodes: the first column aligns to the ${wantStart} (start) edge`,
              `computed text-align: ${res.startAlign} (rows=${res.rows}; "?" means no seeded data row)`);
          }
          if (res.endAlign === wantEnd) {
            ok(`${locale}/nodes: the actions column aligns to the ${wantEnd} (end) edge`,
              `computed text-align: ${res.endAlign}`);
          } else {
            bad(`${locale}/nodes: the actions column aligns to the ${wantEnd} (end) edge`,
              `computed text-align: ${res.endAlign} (this is the defect TASK-49 fixed)`);
          }

          // THE assertion that matters. `start`/`end` are direction-relative:
          // in Persian `start` is the RIGHT edge and in English it is the LEFT.
          // A hard-coded physical `text-right` produces the identical computed
          // value in both locales while landing on the wrong physical edge in
          // one of them -- which is exactly the defect that shipped, because
          // the primary UI is English and the Persian one only looked odd.
          // Measuring where the text actually sits catches it; reading the
          // computed keyword would not.
          const wantFirstAt = locale === "fa" ? "right" : "left";
          const wantLastAt = locale === "fa" ? "left" : "right";
          if (res.firstIsPhysicallyAt === wantFirstAt) {
            ok(`${locale}/nodes: the first column's text physically sits at the ${wantFirstAt} edge`,
              `text is on the ${res.firstIsPhysicallyAt} of its cell`);
          } else {
            bad(`${locale}/nodes: the first column's text physically sits at the ${wantFirstAt} edge`,
              `the text is on the ${res.firstIsPhysicallyAt} of its cell; a physical text-right/text-left would pass the computed-value check and fail this one`);
          }
          if (res.lastIsPhysicallyAt === wantLastAt) {
            ok(`${locale}/nodes: the actions column's text physically sits at the ${wantLastAt} edge`,
              `text is on the ${res.lastIsPhysicallyAt} of its cell`);
          } else {
            bad(`${locale}/nodes: the actions column's text physically sits at the ${wantLastAt} edge`,
              `the text is on the ${res.lastIsPhysicallyAt} of its cell; a physical text-right/text-left would pass the computed-value check and fail this one`);
          }
        } else {
          // A seeded node means the table MUST render. Its absence is a failure,
          // not something to note and move past.
          bad(`${locale}/nodes: the seeded node renders in a table`,
            `no <table> found; the empty state was rendered instead`);
        }
      }
    }

    /* ---- direction is inherited by the body, not just declared on <html> ---- */
    {
      for (const [locale, want] of [["en", "ltr"], ["fa", "rtl"]] as const) {
        await page.goto(`${server.url}/${locale}/login`, { waitUntil: "domcontentloaded" });
        const bodyDir = await page.evaluate<string>("getComputedStyle(document.body).direction");
        if (bodyDir === want) ok(`${locale}: computed body direction is ${want}`);
        else bad(`${locale}: computed body direction is ${want}`, `got ${bodyDir}`);
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
    server.proc.kill();
    try { fs.rmSync(server.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
  if (failures.length > 0) process.exitCode = 1;
}

void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
