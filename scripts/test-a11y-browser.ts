/**
 * Keyboard and focus verification in a real browser (TASK-46).
 *
 * The static baseline (`test-a11y-baseline.ts`) can prove an attribute is
 * present. It cannot prove a keyboard user can actually REACH and OPERATE the
 * control, that focus is visible when it lands, or that the accessible name is
 * what a screen reader would compute. That needs a real DOM and real key
 * events, so this runs against the production build in Chromium.
 *
 * Exit code 77 means the browser could not run at all. That is NOT a pass — it
 * is an explicit "unverified", and it must never be read as green.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pickPort } from "./lib/pick-port";

let pass = 0;
const failures: string[] = [];
const ok = (n: string, x = "") => { pass += 1; console.log(`  ok   ${n}${x ? " — " + x : ""}`); };
const bad = (n: string, d: string) => { failures.push(n); console.log(`  FAIL ${n}\n       ${d}`); };

const REPO = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-a11y-"));
const SKIP = 77;

const freePort = (): Promise<number> => pickPort("127.0.0.1");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Locate playwright-core. It is a pinned devDependency, so the normal
 * resolution path is tried first; the npx cache is a fallback for hosts where
 * the install has not been run.
 */
function findPlaywright(): PW | null {
  // Resolve the REAL installed dependency first. `playwright-core` is a pinned
  // devDependency (1.63.0), so a plain require("playwright-core") always works
  // on any host, including a fresh CI runner.
  //
  // The npx-cache hunt below is retained only as a fallback. Relying on it was a
  // genuine defect: `npx playwright install` downloads browsers into a cache
  // keyed by an npx hash, so the cache layout on a clean Linux runner differs
  // from a developer's machine. That made the suite SKIP locally-verified work
  // in CI -- a browser gate that never ran while still reporting success.
  try { return createRequire(import.meta.url ?? __filename)("playwright-core") as PW; } catch { /* fall through */ }

  const candidates = [
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
      const q = path.join(root, "playwright-core");
      if (fs.existsSync(q)) {
        try { return createRequire(import.meta.url ?? __filename)(q); } catch { /* next */ }
      }
    }
  }
  return null;
}

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
  const dirs = fs.readdirSync(cache).filter((d) => d.startsWith("chromium")).sort().reverse();
  const rel = process.platform === "win32"
    ? ["chrome-win64/chrome.exe"]
    : process.platform === "darwin"
      ? ["chrome-mac/Chromium.app/Contents/MacOS/Chromium"]
      : ["chrome-linux/chrome"];
  for (const d of dirs) for (const r of rel) {
    const p = path.join(cache, d, r);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms: number, what: string) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The minimum surface of playwright-core this suite touches. */
interface Chromium {
  launch(opts: { headless: boolean; executablePath?: string; args: string[] }): Promise<Browser>;
}
interface Browser {
  newContext(): Promise<Context>;
  close(): Promise<void>;
}
interface Context {
  newPage(): Promise<Page>;
}
interface Page {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  click(sel: string, opts?: { timeout?: number }): Promise<void>;
  fill(sel: string, value: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  waitForURL(pred: (u: URL) => boolean, opts?: { timeout?: number }): Promise<void>;
  waitForFunction(fn: () => boolean, arg: null, opts?: { timeout?: number }): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  $(sel: string): Promise<unknown>;
}
interface PW { chromium: Chromium }

let browser: Browser | null = null;
let page: Page | null = null;
let server: ChildProcess | null = null;

async function main() {
  // --- browser -------------------------------------------------------------
  // playwright-core is NOT a project dependency: it lives in the npx cache the
  // browser download was registered against. A bare `import("playwright")`
  // throws, which would make this suite skip itself as UNVERIFIED forever.
  const pw = findPlaywright();
  if (!pw) {
    console.log("  SKIP playwright-core is not installed on this host — keyboard/focus is UNVERIFIED");
    process.exit(SKIP);
  }
  // playwright-core looks for a specific chromium build; this host has an
  // older one cached. Use the binary that is actually present rather than
  // requiring a ~150MB download to run a test — and if none is present, say
  // UNVERIFIED rather than quietly passing.
  const exe = findChromium();
  try {
    browser = await pw.chromium.launch({
      headless: true,
      ...(exe ? { executablePath: exe } : {}),
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (e) {
    console.log(`  SKIP chromium could not launch (${(e as Error).message.slice(0, 80)}) — UNVERIFIED`);
    process.exit(SKIP);
  }

  // --- data dir + app ------------------------------------------------------
  const dataDir = path.join(TMP, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "a11y.db");
  const env = {
    ...process.env,
    DATABASE_URL: `file:${dbPath}`,
    XT_DATA_DIR: dataDir,
    XT_BIN_DIR: path.join(dataDir, "bin"),
    NODE_ENV: "production",
    // Placeholder-only secrets. Never a real value.
    XTENC_KEY: "0".repeat(64),
    JWT_SECRET: "1".repeat(64),
    // Trust the proxy is off: these tests are single-origin.
    XT_TRUST_PROXY: "false",
  };

  // Migrate the throwaway DB with the SAME script the installer uses, which
  // applies the SQL through node:sqlite. The Prisma CLI needs a generated
  // client and a build-host engine, and this suite must run against a plain
  // build — so using the CLI here would test a different path than production.
  {
    const r = spawnSync(process.execPath, [
      path.join(REPO, "scripts/apply-migrations.mjs"),
      "--database", dbPath,
    ], { encoding: "utf8" });
    if (r.status !== 0) {
      console.log(`  SKIP apply-migrations failed (status ${r.status}) — keyboard/focus is UNVERIFIED`);
      console.log(`       ${(r.stderr || r.stdout || "").slice(0, 300)}`);
      process.exit(SKIP);
    }
  }

  const port = await freePort();
  const nextBin = path.join(REPO, "node_modules/next/dist/bin/next");
  server = spawn(process.execPath, [nextBin, "start", "-p", String(port)], {
    cwd: path.join(REPO, "apps/web"),
    env: { ...env, PORT: String(port) },
    stdio: "ignore",
  });
  await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      return r.ok;
    } catch { return false; }
  }, 120_000, "the app to answer /api/health");

  // --- disposable admin ----------------------------------------------------
  const email = `a11y-${Date.now()}@example.invalid`;
  const password = "A11y-Probe-Password-1";
  {
    const r = spawnSync(process.execPath, [
      path.join(REPO, "scripts/create-admin.mjs"),
      "--database", dbPath, "--email", email, "--password", password,
    ], { encoding: "utf8" });
    if (r.status !== 0) {
      console.log(`  SKIP create-admin failed (status ${r.status}) — keyboard/focus is UNVERIFIED`);
      console.log(`       ${(r.stderr || r.stdout || "").slice(0, 300)}`);
      process.exit(SKIP);
    }
  }

  // --- login ---------------------------------------------------------------
  const context = await browser.newContext();
  page = await context.newPage();

  for (const locale of ["en", "fa"] as const) {
    console.log(`\n--- ${locale}: keyboard reachability and focus ---`);
    await page.goto(`http://127.0.0.1:${port}/${locale}/login`, { waitUntil: "domcontentloaded" });

    if (locale === "en") {
      // Sign in once; the session cookie carries to /fa.
      await page.fill('input[type="email"]', email);
      await page.fill('input[type="password"]', password);
      await Promise.all([
        page.waitForURL((u) => !u.pathname.endsWith("/login"), { timeout: 30_000 }),
        page.click('button[type="submit"]'),
      ]);
      ok(`${locale}: signed in with a disposable admin`);
    } else {
      await page.goto(`http://127.0.0.1:${port}/${locale}`, { waitUntil: "domcontentloaded" });
    }

    // A Sonner toast mounts on login and takes focus. Chromium's
    // :focus-visible heuristic then treats the NEXT Tab as a mouse-initiated
    // focus, so the control immediately after the toast measures as
    // unfocused -- an artifact of the measurement, not a defect in the UI.
    // Dismiss toasts before walking so every reading reflects real keyboard use.
    await page.evaluate(() => {
      for (const t of Array.from(document.querySelectorAll("[data-sonner-toast]"))) {
        t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      }
    });
    await sleep(300);
    await page.evaluate(() => {
      for (const t of Array.from(document.querySelectorAll("[data-sonner-toast]"))) {
        (t as HTMLElement).style.display = "none";
      }
    });

    // Direction is a precondition for every alignment and reading-order claim.
    const dir = await page.evaluate(() => document.documentElement.getAttribute("dir") || document.body.dir || "");
    if (dir === (locale === "fa" ? "rtl" : "ltr")) ok(`${locale}: document direction is ${dir}`);
    else bad(`${locale}: document direction`, `expected ${locale === "fa" ? "rtl" : "ltr"}, got "${dir}"`);

    // --- every focusable control must be reachable by Tab alone -----------
    const reachable = await page.evaluate(() => {
      const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      const all = [...document.querySelectorAll<HTMLElement>(sel)].filter((el) => {
        // offsetParent is null for position:fixed and for anything inside a
        // transformed ancestor, so it under-reports. A rect is the honest test.
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        const cs = getComputedStyle(el);
        return cs.display !== "none" && cs.visibility !== "hidden";
      });
      const noName = all.filter((el) => {
        const aria = el.getAttribute("aria-label");
        const labelled = aria && aria.trim().length > 0;
        const text = (el.textContent ?? "").trim();
        const title = el.getAttribute("title");
        // A form control is named by its <label for>, wrapping label, or aria-label.
        if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
          if (labelled) return false;
          if (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) return false;
          if (el.closest("label")) return false;
          if (el.getAttribute("aria-labelledby")) return false;
          if (text.length > 0) return false;      // e.g. a button wrapping text
          return true;
        }
        return !(labelled || text.length > 0 || (title && title.length > 0));
      });
      return { total: all.length, unnamed: noName.map((el) => el.outerHTML.slice(0, 110)) };
    });
    if (reachable.total === 0) {
      bad(`${locale}: the name check found controls to check`,
        "0 focusable controls matched the selector — a vacuous pass proves nothing");
    } else if (reachable.unnamed.length === 0) {
      ok(`${locale}: all ${reachable.total} focusable controls have an accessible name`);
    } else {
      bad(`${locale}: all focusable controls have an accessible name`,
        `${reachable.unnamed.length}/${reachable.total}: ${reachable.unnamed.join(" | ")}`);
    }

    // --- Tab actually moves focus, and the indicator is visible ----------
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      document.body.focus();
    });
    const seen: string[] = [];
    const noRingDetail: string[] = [];
    const thirdPartyNoRing: string[] = [];
    let noIndicator = 0;
    let wrappedOut = false;
    /** Every element the browser actually focused, with its ring state. */
    const focusLog: Array<Record<string, unknown>> = [];
    const MAX_TABS = 60;
    for (let i = 0; i < MAX_TABS; i++) {
      await page.keyboard.press("Tab");
      // A toast can mount and take focus between the keypress and the read.
      // Wait for the active element to be stable so the measurement belongs to
      // the element that was actually focused by this Tab.
      await page.waitForFunction(() => {
        const el = document.activeElement as HTMLElement | null;
        return !!el && !el.hasAttribute("data-sonner-toast");
      }, null, { timeout: 2000 }).catch(() => { /* fall through and measure */ });
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        // `document.body` here means focus is NOT in the document. Reporting
        // the previous node's reading is how a correct control ends up
        // recorded as having no focus indicator.
        if (!el || el === document.body || el === document.documentElement) return null;
        const cs = getComputedStyle(el);
        // Tailwind's ring is a box-shadow built from --tw-ring-* custom
        // properties. `getComputedStyle().boxShadow` resolves it, but the
        // RESTING state also carries a (transparent) ring, so "boxShadow !==
        // none" is true even with no visible focus ring -- it would report a
        // false PASS. Compare against the element's own unfocused value
        // instead: an indicator is a CHANGE, not the presence of a property.
        const isAnchorNewTab = el.tagName === "A" && el.getAttribute("target") === "_blank";
        const thirdParty =
          el.hasAttribute("data-sonner-toast") ||
          el.hasAttribute("data-radix-popper-content-wrapper") ||
          el.closest("[data-sonner-toast]") !== null;
        const shadow = cs.boxShadow && cs.boxShadow !== "none" ? cs.boxShadow : "";
        const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
        // CSSStyleDeclaration.getPropertyValue reads custom properties directly.
        const ringColour = cs.getPropertyValue("--tw-ring-color").trim();
        const ringShadow = cs.getPropertyValue("--tw-ring-shadow").trim();
        const ring = Boolean(outline) ||
          (shadow && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(shadow)) ||
          (ringShadow && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(ringShadow) && !!ringColour);
        const tag = el.tagName.toLowerCase();
        return {
          tag,
          label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 34),
          ring, shadow, outline, thirdParty, isAnchorNewTab,
          matchesFV: el.matches(":focus-visible"),
          // Chromium does not apply :focus-visible to a link focused purely by
          // sequential Tab when the last interaction was a MOUSE press elsewhere
          // on the page (the :focus-visible heuristic). Record whether a prior
          // mouse event happened, because that changes the answer WITHOUT any
          // change in the markup -- which is why this looked like a bug.
          tabIndex: (el as HTMLElement).tabIndex,
          isBody: tag === "body",
        };
      });
      if (!info || info.isBody) {
        // Focus left the document (Tab wrapped to the browser chrome). The
        // previous reading is now stale, so stop rather than re-report it: this
        // is what made the LAST control in DOM order look like it had no
        // indicator when it does.
        wrappedOut = true;
        break;
      }
      seen.push(`${info.tag}:${info.label}`);
      focusLog.push({ tag: info.tag, label: info.label, ring: info.ring, shadow: info.shadow, outline: info.outline, matchesFV: info.matchesFV, thirdParty: info.thirdParty });
      if (!info.ring) {
        noIndicator++;
        // Only report FOCUSABLE elements. A <li> can hold document.activeElement
        // transiently without being a focus target, and its resting box-shadow
        // is decoration, not a focus indicator.
        // A toast from sonner carries tabindex="0" and no class of ours. It is
        // third-party markup: this contract covers the panel's own controls, so
        // it is counted separately instead of silently passing or failing.
        const thirdParty = info.thirdParty;
        const focusable = /^(a|button|input|select|textarea)$/i.test(info.tag) || info.tabIndex >= 0;
        if (thirdParty) {
          thirdPartyNoRing.push(`${info.tag}"${info.label}"`);
        } else if (focusable) {
          noRingDetail.push(`${info.tag}"${info.label}" shadow="${info.shadow}" outline=${info.outline}`);
        } else {
          noIndicator--;
        }
      }
    }
    if (seen.length > 0) {
      ok(`${locale}: Tab reached ${seen.length} controls in order`,
        wrappedOut ? "(walk ended when focus left the document)" : "");
    }
    else bad(`${locale}: Tab reached controls`, "Tab never moved focus off the body");
    if (noIndicator === 0) {
      ok(`${locale}: every focused control paints a visible indicator (2.4.7)`,
        thirdPartyNoRing.length > 0 ? `${thirdPartyNoRing.length} third-party toast element(s) excluded` : "");
    } else {
      bad(`${locale}: every focused control paints a visible indicator (2.4.7)`,
        `${noRingDetail.join(" | ")}\n       focus log: ${JSON.stringify(focusLog.slice(0, 8))}`);
    }

    // --- form error association, measured on a real node ------------------
    await page.goto(`http://127.0.0.1:${port}/${locale}/nodes`, { waitUntil: "domcontentloaded" });
    const dialog = await page.$('[role="dialog"]');
    if (dialog) {
      await page.click('[role="dialog"] button:has-text("New"), [role="dialog"] button >> nth=-1').catch(() => {});
      await sleep(400);
    }
    const assoc = await page.evaluate(() => {
      const out: { ok: boolean; detail: string }[] = [];
      for (const el of document.querySelectorAll<HTMLInputElement>("input, select, textarea")) {
        if ((el as HTMLInputElement).type === "hidden") continue;
        const labelled = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        const wrapped = el.closest("label");
        const aria = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
        const named = Boolean(labelled || wrapped || aria);
        if (!named) out.push({ ok: false, detail: el.outerHTML.slice(0, 90) });
        // If describedby points at something, it must EXIST.
        const db = el.getAttribute("aria-describedby");
        if (db) {
          for (const id of db.split(/\s+/).filter(Boolean)) {
            if (!document.getElementById(id)) out.push({ ok: false, detail: `aria-describedby=${id} resolves to nothing` });
          }
        }
      }
      return out;
    });
    if (assoc.length === 0) ok(`${locale}: every form control is named and every describedby resolves`);
    else bad(`${locale}: form control labelling is sound`, assoc.map((a) => a.detail).join(" | "));

    // --- a validation error, if reachable, must be announced -------------
    const errAnnounced = await page.evaluate(() => {
      const alerts = [...document.querySelectorAll('[role="alert"]')];
      return {
        count: alerts.length,
        anyDescribed: alerts.some((a) => a.id && !!document.querySelector(`[aria-describedby~="${CSS.escape(a.id)}"]`)),
      };
    });
    if (errAnnounced.count === 0) {
      ok(`${locale}: no validation error was raised in this pass (nothing to announce)`);
    } else if (errAnnounced.anyDescribed) {
      ok(`${locale}: the validation error is both announced and associated with its control`);
    } else {
      bad(`${locale}: the validation error is associated with its control`, "role=alert present but no aria-describedby references it");
    }
  }

  console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
  if (failures.length > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(`  ERROR ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await browser?.close(); } catch { /* already gone */ }
    try { server?.kill(); } catch { /* already gone */ }
    await sleep(300);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp dir */ }
  });
