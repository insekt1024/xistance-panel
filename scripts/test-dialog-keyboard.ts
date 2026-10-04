/**
 * Browser verification of dialog keyboard accessibility (TASK-47).
 *
 * The acceptance criteria name behaviour that cannot be read from source:
 * focus entering a dialog, focus TRAPPED inside it, Escape closing it, and
 * focus RETURNED to the element that opened it. All four are Radix behaviours
 * that only exist while the component stays mounted -- so this exercises them
 * against a real production build in a real Chromium.
 *
 * What it proves, per dialog:
 *   - opens by keyboard alone (hotkey, or Tab to trigger + Enter);
 *   - focus moves INTO the dialog on open;
 *   - Tab cycles within the dialog and never escapes (2.1.2 No Keyboard Trap);
 *   - Escape closes it;
 *   - focus returns to the trigger;
 *   - the dialog has an accessible name;
 *   - the focused control is not hidden behind a sticky header/footer.
 *
 * A dialog that is only *conditionally* mounted cannot return focus: the
 * trigger's ref is gone by the time Radix would restore to it. That is the
 * specific defect this suite was written to catch, and the source check for it
 * lives in test-a11y-baseline.ts.
 *
 * Exit code 77 means "could not run here" and is distinct from pass and fail.
 */

import { findChromiumExecutable } from "./lib/chromium-path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import assert from "node:assert";
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

interface Browser { newContext(): Promise<Context>; close(): Promise<void>; }
interface Context { newPage(): Promise<Page>; }
interface Page {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  click(sel: string, opts?: Record<string, unknown>): Promise<void>;
  fill(sel: string, value: string): Promise<void>;
  press(sel: string, key: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  waitForURL(pred: (u: URL) => boolean, opts?: { timeout?: number }): Promise<void>;
  waitForFunction(fn: string, opts?: { timeout?: number }): Promise<void>;
  evaluate<T>(fn: string): Promise<T>;
  $(sel: string): Promise<unknown>;
}
interface PW { chromium: { launch(opts: Record<string, unknown>): Promise<Browser> } }

function findPlaywright(): PW | null {
  // Resolve the REAL installed dependency first: `playwright-core` is a pinned
  // devDependency (1.63.0), so plain resolution works on any host including a
  // fresh CI runner. The npx-cache hunt below is a fallback only -- npx caches
  // are keyed by a transient hash, so their layout differs between a developer
  // machine and a clean runner, which is how a browser gate silently SKIPPED in
  // CI while passing locally.
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
      const p = path.join(root, "playwright-core");
      if (fs.existsSync(p)) {
        try { return require_(p) as PW; } catch { /* next */ }
      }
    }
  }
  return null;
}

function findChromium(): string | null {
  // One shared resolver, so seven copies cannot drift again. It SEARCHES the
  // cache instead of guessing a per-platform path, which is what missed a modern
  // Linux Playwright install (chromium-<rev>/ AND chromium_headless_shell-<rev>/).
  // See scripts/lib/chromium-path.ts and scripts/test-chromium-path.ts.
  return findChromiumExecutable();
}

/* -------------------------------------------------------------------- util */

const freePort = (): Promise<number> => pickPort("127.0.0.1");

function tempRoot(): string {
  const base = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? os.tmpdir();
  assert.ok(base, "a temporary directory is required");
  const dir = path.join(base, `xistance-dialog-kb-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Radix keeps a CLOSED dialog mounted with data-state="closed" and aria-hidden,
 * so a bare [role=dialog] query matches even when nothing is open. Every
 * open/closed probe goes through one of these three constants.
 */
const DIALOG_OPEN = `JSON.stringify((() => !!Array.from(document.querySelectorAll('[role="dialog"]')).find(d => d.getAttribute("data-state") === "open"))())`;
const DIALOG_CLOSED = `JSON.stringify((() => !Array.from(document.querySelectorAll('[role="dialog"]')).find(d => d.getAttribute("data-state") === "open"))())`;
const ON_TRIGGER = `JSON.stringify((() => document.activeElement === document.querySelector("[data-kb-search-trigger]"))())`;

/** playwright-core is resolved from the npx cache without type definitions, so
 *  `evaluate` is typed as returning T but crosses a string boundary. Every
 *  cross-boundary read goes through JSON.stringify and is compared as a string. */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ server */

// Declared at module scope: startServer() needs them, and main() runs later.
const REPO = process.cwd();
const WEB = path.join(REPO, "apps/web");


interface Server { url: string; serverLog(): string; stop(): Promise<void> }

async function startServer(dir: string, port: number, env: NodeJS.ProcessEnv): Promise<Server> {
  // `next start` from apps/web, exactly as test-rtl-browser.ts does. The
  // standalone server bundles its OWN Prisma client, so a database created by
  // scripts/apply-migrations.mjs is invisible to it and every login fails with
  // a generic "invalid email or password" that looks like a bad credential.
  const nextBin = path.join(REPO, "node_modules/next/dist/bin/next");
  if (!fs.existsSync(nextBin)) skip("next binary not found");
  const child = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: path.join(REPO, "apps/web"),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout?.on("data", (d) => { log += String(d); });
  child.stderr?.on("data", (d) => { log += String(d); });

  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${origin}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (child.exitCode !== null) skip(`server exited (${child.exitCode}): ${log.slice(-400)}`);
    await sleep(250);
  }
  return {
    url: origin,
    serverLog: () => log,
    stop: () => new Promise<void>((res) => { child.once("exit", () => res()); child.kill("SIGTERM"); setTimeout(() => { child.kill("SIGKILL"); res(); }, 4000); }),
  };
}

/* ------------------------------------------------------------- environment */

async function main(): Promise<void> {
  const WEB = path.join(REPO, "apps/web");
  const TMP = tempRoot();
  const DB = path.join(TMP, "xistance.db");
  const PORT = await freePort();
  const ADMIN_EMAIL = process.env.XT_TEST_ADMIN_EMAIL ?? "kb-admin@xistance.test";
  const ADMIN_USER = "kb-admin";
  const ADMIN_PASS = process.env.XT_TEST_ADMIN_PASS ?? "KbAdminPassw0rd!";

  if (!fs.existsSync(path.join(WEB, ".next/standalone/apps/web/server.js"))) {
    skip("no production build (run: TURBO_DISABLE=true npm run build)");
  }
  const pw = findPlaywright();
  if (!pw) skip("playwright-core not resolvable");
  const exe = findChromium();
  if (!exe) skip("no Chromium in the playwright cache");

  // schema + migrations via the CLI-free path the installer uses
  const mig = spawnSync(process.execPath, [path.join(REPO, "scripts/apply-migrations.mjs"), "--database", DB], {
    cwd: REPO, encoding: "utf8",
  });
  if (mig.status !== 0) skip(`migrations failed: ${(mig.stderr || "").slice(-300)}`);
  const adm = spawnSync(process.execPath, [path.join(REPO, "scripts/create-admin.mjs"), "--database", DB, "--email", ADMIN_EMAIL, "--username", ADMIN_USER, "--password", ADMIN_PASS], {
    cwd: REPO, encoding: "utf8",
  });
  if (adm.status !== 0) skip(`admin bootstrap failed: ${(adm.stderr || "").slice(-300)}`);

  // One node, so the row-menu dialog has a row to open.
  //
  // Two schema details cost real time here:
  //   - `id` is `@default(uuid())`; Prisma validates the format on read, so a
  //     non-UUID id makes every node query fail with P2023.
  //   - DateTime on SQLite is stored as INTEGER epoch milliseconds. Writing an
  //     ISO string instead produces "Inconsistent column data" on the same read.
  const { DatabaseSync } = (await import("node:sqlite")) as {
    DatabaseSync: new (p: string) => {
      exec(sql: string): void;
      prepare(sql: string): { all(): unknown[] };
    };
  };
  const seed = new DatabaseSync(DB);
  const ms = Date.now();
  seed.exec(
    "INSERT INTO \"Node\" " +
      '(id, name, type, host, "sshPort", "sshUser", "authMethod", status, "createdAt", "updatedAt") ' +
      "VALUES ('11111111-2222-4333-8444-555555555555', 'kb-node', 'IRAN', '127.0.0.1', 22, " +
      `'root', 'key', 'offline', ${ms}, ${ms})`,
  );
  const readBack = seed.prepare('SELECT id, name FROM "Node"').all();
  seed.close();
  console.log(`  seeded Node rows: ${JSON.stringify(readBack)}`);

  /* ------------------------------------------------------------------- tests */

  // These exact names matter. The RTL suite proved the first two; guessing
  // SESSION_SECRET / XTENC_KEY produced a login that silently did nothing --
  // the form submitted, the server rejected it, and the page sat unchanged.
  const ENV = {
    DATABASE_URL: `file:${DB.replace(/\\/g, "/")}`,
    XT_SESSION_SECRET: "kb-session-secret-0123456789abcdef0123456789abcdef",
    XT_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    XT_TRUST_PROXY: "false",
    NODE_ENV: "production",
    PORT: String(PORT),
  };

  const server = await startServer(WEB, PORT, ENV);
  const browser = await pw.chromium.launch({
    headless: true,
    executablePath: exe ?? undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  /** Radix keeps a CLOSED dialog mounted (data-state="closed", aria-hidden), so
   *  a bare [role=dialog] query matches even when nothing is open. Every
   *  open/closed probe must ask for the OPEN one. playwright-core is resolved
   *  from the npx cache without type definitions, so `evaluate` is typed as
   *  returning T but crosses a string boundary: read a JSON string, not a
   *  bare primitive, or the value arrives undefined and the comparison is
   *  silently false. */
  const isDialogOpen = async (): Promise<boolean> =>
    (await page.evaluate<string>(DIALOG_OPEN)) === "true";
  const isDialogClosed = async (): Promise<boolean> =>
    (await page.evaluate<string>(DIALOG_CLOSED)) === "true";
  const focusOnTrigger = async (): Promise<boolean> =>
    (await page.evaluate<string>(ON_TRIGGER)) === "true";

  const ctx = await browser.newContext();
  const page = await ctx.newPage() as Page;
  // The app's error boundary replaces a crashed page with a generic "Something
  // went wrong" and the real cause exists only in the console, the network, or
  // the server log. Capture all three so a crash is reported as itself.
  const pageErrors: string[] = [];
  const netErrors: string[] = [];
  (page as unknown as { on(e: string, f: (a: unknown, b: unknown) => void): void }).on("console", (m) => {
    const t = (m as { text?: () => string }).text?.() ?? "";
    if (/error|Error/.test(t)) pageErrors.push(t.replace(/\s+/g, " ").slice(0, 200));
  });
  (page as unknown as { on(e: string, f: (a: unknown) => void): void }).on("requestfailed", (r) => {
    const f = r as { url?: () => string; failure?: () => { errorText?: string } | null };
    netErrors.push(`${f.url?.()} :: ${f.failure?.()?.errorText ?? "failed"}`);
  });

  /** One snapshot of the focus + dialog state, read from the page. */
  interface FocusState {
    insideDialog: boolean;
    dialogName: string;
    role: string;
    hasVisibleFocus: boolean;
    activeTag: string;
    obscured: boolean;
  }
  const READ_FOCUS_BODY = `
    const el = document.activeElement;
    // Radix keeps a CLOSED dialog mounted with data-state="closed" and
    // aria-hidden, so a bare [role=dialog] query matches even when nothing is
    // open. That made "the dialog never opened" true while the DOM said
    // otherwise. Only the open one counts.
    const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find(d => d.getAttribute("data-state") === "open") || null;
    // A missing dialog is NORMAL -- the trigger is measured before any dialog
    // is open. Returning early here made every such reading report
    // hasVisibleFocus:false, which is a measurement bug that looked exactly like
    // "the button paints no focus ring". Only bail when there is no active
    // element at all.
    if (!el) return { insideDialog: false, dialogName: "", role: "", hasVisibleFocus: false, activeTag: "", obscured: false, obscuredBy: "" };
    const cs = getComputedStyle(el);
    const ring = cs.getPropertyValue("--tw-ring-shadow").trim();
    const ringColour = cs.getPropertyValue("--tw-ring-color").trim();
    const offset = cs.getPropertyValue("--tw-ring-offset-shadow").trim();
    // Identical to the detector in test-a11y-browser.ts, which walks 22 of 22
    // controls green. Re-derive the same signals instead of a looser test: a
    // variant that only looked at --tw-ring-shadow reported a false failure on a
    // Button that demonstrably paints a ring.
    const shadow = cs.boxShadow;
    const transparent = (v) => !v || /rgba\(0,\s*0,\s*0,\s*0\)|transparent/.test(v);
    const hasVisibleFocus =
      (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) ||
      !transparent(shadow) ||
      (!transparent(ring) && !!ringColour) ||
      !transparent(offset);
    // 2.4.11 focus not obscured: is the focused element's top edge under a
    // sticky/fixed header or footer?
    const r = el.getBoundingClientRect();
    let obscured = false;
    for (const n of document.querySelectorAll("*")) {
      const s = getComputedStyle(n);
      if (s.position !== "sticky" && s.position !== "fixed") continue;
      if (n === el || n.contains(el) || el.contains(n)) continue;
      // A modal dialog is SUPPOSED to cover the page. Radix's own fixed inset-0
      // overlay and portal wrapper would otherwise register as "obscuring" the
      // control inside their own dialog -- a false 2.4.11 failure. Only chrome
      // from OUTSIDE the open dialog counts.
      // The overlay is a SIBLING of the dialog content (Radix renders
      // Overlay + Content into one portal), so dlg.contains(n) is false for it.
      // What matters is only whether the node belongs to the dialog's own
      // portal: exclude anything inside the element that holds [role=dialog].
      const portal = dlg ? (dlg.closest("[data-radix-portal], [data-state]")?.parentElement ?? null) : null;
      if (dlg && (dlg.contains(n) || n.contains(dlg) || (portal && portal.contains(n)))) continue;
      const nr = n.getBoundingClientRect();
      if (nr.width === 0 || nr.height === 0) continue;
      const z = parseInt(s.zIndex || "0", 10);
      if (!(z >= 1)) continue;
      if (r.top < nr.bottom && r.bottom > nr.top && r.left < nr.right && r.right > nr.left) {
        obscured = n.tagName.toLowerCase() + "." + (n.className||"").toString().split(" ").slice(0,3).join(".") + "|z=" + s.zIndex; break;
      }
    }
    // Resolve the accessible name the way a screen reader does:
    //   aria-label wins; otherwise follow aria-labelledby to the referenced
    //   element's text. An aria-hidden label contributes NOTHING, which is what
    //   M6 exploited: marking the DialogTitle aria-hidden left the id in
    //   aria-labelledby, and a check that only looked for a non-empty
    //   attribute passed.
    let dialogName = "";
    if (dlg) {
      const ariaLabel = (dlg.getAttribute("aria-label") || "").trim();
      if (ariaLabel) dialogName = ariaLabel;
      const labelledBy = (dlg.getAttribute("aria-labelledby") || "").trim();
      if (!dialogName && labelledBy) {
        dialogName = labelledBy
          .split(/\s+/)
          .map((id) => {
            const n = document.getElementById(id);
            if (!n) return "";
            // aria-hidden on the label means the text is not exposed.
            if (n.getAttribute("aria-hidden") === "true") return "";
            if (n.closest('[aria-hidden="true"]')) return "";
            return (n.textContent || "").trim();
          })
          .filter(Boolean)
          .join(" ");
      }
    }
    return { obscuredBy: obscured, insideDialog: !!dlg && dlg.contains(el), dialogName: (dialogName || "").trim(), role: dlg ? (dlg.getAttribute("role") || "") : "", hasVisibleFocus, activeTag: el.tagName.toLowerCase(), obscured };
`;

  // playwright-core is loaded from the npx cache without its type definitions,
  // so `evaluate` is typed as returning `T` but the value crosses a string
  // boundary. Round-trip through JSON once, here, rather than at 20 call sites.
  const focus = async (): Promise<FocusState> => {
    const json = await page.evaluate<string>("JSON.stringify((function() {" + READ_FOCUS_BODY + "})())");
    return JSON.parse(json) as FocusState;
  };

  async function login(locale: string): Promise<void> {
    // React tracks input values through its own value setter, so a bare
    // `.value =` leaves the state empty and the submit sends blanks. Drive the
    // native setter and fire `input`, then requestSubmit -- the same path the
    // passing RTL suite uses.
    await page.goto(`${server.url}/en/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("input#email", { timeout: 30_000 });
    await page.evaluate(`(() => {
      const fill = (sel, v) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error("missing field " + sel);
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      fill('input#email', ${JSON.stringify(ADMIN_EMAIL)});
      fill('input#password', ${JSON.stringify(ADMIN_PASS)});
      const form = document.querySelector("form");
      if (!form) throw new Error("no login form");
      if (form.requestSubmit) form.requestSubmit();
      else form.dispatchEvent(new Event("submit", { bubbles: true }));
    })()`);
    // The submit triggers a client-side navigation. Polling location.pathname
    // races it: evaluate() lands mid-navigation and the execution context is
    // destroyed. Wait for the redirect to settle first, THEN read the URL.
    await sleep(1500);
    let landed = "";
    for (let i = 0; i < 20; i++) {
      try {
        landed = await page.evaluate<string>("location.pathname");
        break;
      } catch {
        await sleep(400);
      }
    }
    if (!landed || landed.includes("/login")) {
      const why = await page.evaluate<string>(`(() => {
        const t = document.body.innerText || "";
        const alert = Array.from(document.querySelectorAll('[role="alert"],[role="status"]'))
          .map(n => n.textContent || "").filter(Boolean).join(" | ");
        return (alert || t).replace(/\s+/g, " ").slice(0, 220);
      })()`).catch(() => "(could not read the page)");
      bad(`${locale}: signed in with a disposable admin`,
        landed ? `still on ${landed}: ${why}` : "could not read the URL after submitting the login form");
    }
    else ok(`${locale}: signed in with a disposable admin`, `landed on ${landed}`);
    // Third-party toasts steal focus and flip Chromium's :focus-visible
    // heuristic for the next Tab, so remove them before measuring.
    await page.evaluate(`() => {
      document.querySelectorAll("[data-sonner-toast]").forEach(n => n.remove());
    }`);
    await sleep(250);
  }

  /** Open a dialog by keyboard and verify the full contract. */

  for (const locale of ["en", "fa"]) {
    console.log(`\n--- ${locale}: dialog keyboard contract ---`);
    // The session cookie survives the first sign-in, so /<locale>/login
    // redirects to the app shell and the form no longer exists. Sign in once
    // per run and reuse it; the per-locale work is the DIALOG contract, which
    // is the same tree in both locales.
    const alreadyIn = await page.evaluate<string>("location.pathname").catch(() => "");
    if (locale === "fa" && !alreadyIn.includes("/login")) {
      ok(`${locale}: reusing the authenticated session`, `already signed in on ${alreadyIn}`);
    } else {
      await login(locale);
    }

    // 1. Search dialog: the navbar trigger, opened and dismissed by keyboard.
    {
      const p = `${locale}: search dialog`;
      await page.goto(`${server.url}/${locale}/tunnels`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(400);
      await page.evaluate(`() => {
        document.querySelectorAll("[data-sonner-toast]").forEach(n => n.remove());
        if (document.activeElement) document.activeElement.blur();
      }`);

      const found = JSON.parse(await page.evaluate<string>(`JSON.stringify((() => {
        // The navbar search button carries NO text below the lg breakpoint: its
        // only label sits in a hidden lg:inline span, so it cannot be located by
        // its label. Match lucide's icon class and read the accessible name back
        // off the element -- which is exactly what 4.1.2 is about.
        const svg = document.querySelector("button svg.lucide-search");
        if (!svg) return { kind: "missing", why: "no button svg.lucide-search in the document", named: false, name: "" };
        const b = svg.closest("button");
        if (!b) return { kind: "missing", why: "the search icon is not inside a button", named: false, name: "" };
        const name = (b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent || "").trim();
        b.setAttribute("data-kb-search-trigger", "1");
        return { kind: "found", named: name.length > 0, name };
      })())`)) as { kind: string; why: string; named: boolean; name: string };

      if (found.kind === "missing") {
        bad(`${p} trigger exists`, found.why);
      } else if (!found.named) {
        // A real 4.1.2 failure, not a harness problem: icon-only and unnamed at
        // every width below lg.
        bad(`${p} trigger has an accessible name`,
          "the navbar search button is icon-only with no aria-label; its text is hidden below lg");
      } else {
        ok(`${p} trigger has an accessible name`, found.name);

        // Reach the trigger with a REAL Tab. A programmatic .focus() does not
        // satisfy :focus-visible in Chromium, so a Button that provably has a
        // ring would otherwise measure as "no indicator".
        // Reach the trigger with a REAL Tab. A programmatic .focus() does not
        // satisfy :focus-visible in Chromium, so a Button that provably has a
        // ring would otherwise measure as "no indicator".
        let landed = false;
        const walk: string[] = [];
        for (let i = 0; i < 30 && !landed; i++) {
          await page.keyboard.press("Tab");
          const st = await page.evaluate<string>(
            `(() => { const el = document.activeElement; return el ? el.tagName.toLowerCase() + (el.hasAttribute("data-kb-search-trigger") ? "*" : "") : "none"; })()`);
          walk.push(st);
          landed = st.endsWith("*");
        }
        if (!landed) {
          bad(`${p} trigger is reachable by Tab`, `walk=${walk.join(">")}`);
        } else {
          const trig = await focus();
          if (trig.hasVisibleFocus) ok(`${p} trigger shows a visible focus indicator`);
          else bad(`${p} trigger shows a visible focus indicator`,
            "Tab reached the trigger but it paints no outline and no ring");

          // Two documented open paths. SearchDialog is a next/dynamic chunk
          // with ssr:false, so opening it is a network fetch first.
          await page.keyboard.press("Enter");
          let opened = false;
          for (let i = 0; i < 120 && !opened; i++) {
            opened = await isDialogOpen();
            if (!opened) await sleep(100);
          }
          if (!opened) {
            await page.keyboard.press("Control+k");
            for (let i = 0; i < 120 && !opened; i++) {
              opened = await isDialogOpen();
              if (!opened) await sleep(100);
            }
          }
          if (!opened) {
            const why = await page.evaluate<string>(`(() => {
              const el = document.activeElement;
              return "focus on <" + (el ? el.tagName.toLowerCase() : "?") + ">; " + JSON.stringify({
                dialogs: Array.from(document.querySelectorAll('[role="dialog"]')).map(d => d.getAttribute("data-state")),
                console: ${JSON.stringify(pageErrors)}.slice(0, 160),
              });
            })()`);
            bad(`${p} opens with the keyboard`, `neither Enter nor Ctrl+K opened a dialog: ${why}`);
          } else {
            ok(`${p} opens with the keyboard`);

            const onOpen = await focus();
            if (onOpen.insideDialog) ok(`${p} moves focus into the dialog on open`, `<${onOpen.activeTag}>`);
            else bad(`${p} moves focus into the dialog on open`, `focus stayed on <${onOpen.activeTag}>`);

            if (onOpen.role === "dialog") ok(`${p} exposes role=dialog`);
            else bad(`${p} exposes role=dialog`, `role was "${onOpen.role || "(none)"}"`);

            if (onOpen.dialogName) ok(`${p} has an accessible name`, onOpen.dialogName);
            else bad(`${p} has an accessible name`, "no aria-label and no resolvable aria-labelledby");

            if (onOpen.hasVisibleFocus) ok(`${p} shows a visible focus indicator on the initial control`);
            else bad(`${p} shows a visible focus indicator on the initial control`,
              "the element that received focus paints no outline and no ring");

            if (!onOpen.obscured) ok(`${p} focus is not obscured by a sticky header or footer (2.4.11)`);
            else bad(`${p} focus is not obscured by a sticky header or footer (2.4.11)`,
              `a sticky or fixed element overlaps the focused control: ${onOpen.obscuredBy}`);

            // 2.1.2 No Keyboard Trap: Tab must wrap inside, never escape.
            let escaped = false;
            for (let i = 0; i < 14 && !escaped; i++) {
              await page.keyboard.press("Tab");
              escaped = !(await focus()).insideDialog;
            }
            if (escaped) bad(`${p} traps focus inside the dialog (2.1.2)`, "Tab moved focus out of the open dialog");
            else ok(`${p} traps focus inside the dialog (2.1.2)`);

            await page.keyboard.press("Escape");
            let closed = false;
            for (let i = 0; i < 40 && !closed; i++) {
              closed = await isDialogClosed();
              if (!closed) await sleep(50);
            }
            if (closed) ok(`${p} closes on Escape`);
            else bad(`${p} closes on Escape`, "still in the DOM after Escape");

            // THE defect this suite exists for: a dialog that cannot hand focus
            // back drops a keyboard user at the top of the page.
            await sleep(400);
            const ret = JSON.parse(await page.evaluate<string>(`JSON.stringify((() => {
              const el = document.activeElement;
              if (!el) return { ok: false, why: "no active element" };
              if (el === document.body) return { ok: false, why: "focus fell back to <body>" };
              if (el.closest('[role="dialog"]')) return { ok: false, why: "focus is still inside the dialog" };
              const t = document.querySelector("[data-kb-search-trigger]");
              return t && t.contains(el)
                ? { ok: true, why: "returned to the trigger" }
                : { ok: false, why: "focus landed on <" + el.tagName.toLowerCase() + ">, not the trigger" };
            })())`)) as { ok: boolean; why: string };
            if (ret.ok) ok(`${p} returns focus to the trigger`, ret.why);
            else bad(`${p} returns focus to the trigger`, ret.why);
          }
        }
      }
    }


    // 2. A Radix DropdownMenu on a table row: the other dialog shape. Keyboard
    //    must open it, move focus in, and return focus to the trigger on Escape.
    {
      const p = `${locale}: node row menu`;
      // The seeded node is rendered on /nodes. This block used to run while
      // still on /tunnels, find no row, and print a green "skipped" tick that
      // proved nothing -- a vacuous pass, which is worse than a red one.
      const logBefore = server.serverLog().length;
      await page.goto(`${server.url}/${locale}/nodes`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(1200);
      await page.evaluate(`() => { document.querySelectorAll("[data-sonner-toast]").forEach(n => n.remove()); }`);

      const found = (await page.evaluate<string>(`JSON.stringify((() => {
        for (const r of Array.from(document.querySelectorAll("tr"))) {
          if (!r.textContent || !r.textContent.includes("kb-node")) continue;
          const btns = Array.from(r.querySelectorAll("button"));
          const menu = btns.find(b => b.getAttribute("aria-haspopup") === "menu")
                    || btns[btns.length - 1];
          if (menu) { menu.setAttribute("data-kb-row-menu", "1"); return true; }
        }
        return false;
      })())`)) === "true";

      if (!found) {
        const rows = await page.evaluate<string>(`(() => {
          const rs = Array.from(document.querySelectorAll("tr")).map(r => (r.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50));
          return JSON.stringify({
            url: location.pathname,
            tables: document.querySelectorAll("table").length,
            rows: rs.length,
            sample: rs.slice(0, 3),
            body: (document.body.innerText || "").replace(/\s+/g, " ").slice(0, 200),
          });
        })()`);
        bad(`${p} renders the seeded node`,
          `no row contained "kb-node": ${rows}\n       console: ${pageErrors.slice(0,3).join(" || ") || "(none)"}\n       network: ${netErrors.slice(0,3).join(" || ") || "(none)"}\n       server(since nav): ${server.serverLog().slice(logBefore).replace(/\s+/g," ").slice(0, 400) || "(no new server output)"}`);
      } else {
        // Reach it with a real Tab so :focus-visible applies.
        const info = JSON.parse(await page.evaluate<string>(`JSON.stringify((() => {
          const t = document.querySelector("[data-kb-row-menu]");
          if (!t) return { found: false };
          return {
            found: true,
            tabIndex: t.tabIndex,
            disabled: !!t.disabled,
            hasPopup: t.getAttribute("aria-haspopup"),
            rect: (() => { const r = t.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })(),
            totalFocusable: document.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])').length,
          };
        })())`)) as Record<string, unknown>;
        const walk: string[] = [];
        let landed = false;
        for (let i = 0; i < 60 && !landed; i++) {
          await page.keyboard.press("Tab");
          const cur = await page.evaluate<string>(`(() => { const el = document.activeElement; return el ? el.tagName.toLowerCase() + (el === document.querySelector("[data-kb-row-menu]") ? "*" : "") : "none"; })()`);
          walk.push(cur);
          if (cur.endsWith("*")) landed = true;
        }
        if (!landed) {
          bad(`${p} trigger is reachable by Tab`, `info=${JSON.stringify(info)} walk=${walk.join(">")}`);
        } else {
          const menuVisible = await focus();
          if (menuVisible.hasVisibleFocus) ok(`${p} trigger shows a visible focus indicator`);
          else bad(`${p} trigger shows a visible focus indicator`, "Tab reached the trigger but it paints no indicator");

          await page.keyboard.press("Enter");
          let menuOpen = false;
          for (let i = 0; i < 60 && !menuOpen; i++) {
            menuOpen = (await page.evaluate<string>(`JSON.stringify((() => !!Array.from(document.querySelectorAll('[role="menu"]')).find(m => m.getAttribute("data-state") === "open"))())`)) === "true";
            if (!menuOpen) await sleep(100);
          }
          if (!menuOpen) {
            bad(`${p} opens with the keyboard`, "Enter on the row menu produced no open role=menu");
          } else {
            ok(`${p} opens with the keyboard`);
            const inMenu = (await page.evaluate<string>(`JSON.stringify((() => {
              const m = Array.from(document.querySelectorAll('[role="menu"]')).find(x => x.getAttribute("data-state") === "open");
              const el = document.activeElement;
              return !!(m && el && m.contains(el));
            })())`)) === "true";
            if (inMenu) ok(`${p} moves focus into the menu`);
            else bad(`${p} moves focus into the menu`, "focus was not inside the open role=menu");

            await page.keyboard.press("Escape");
            let closed = false;
            for (let i = 0; i < 40 && !closed; i++) {
              closed = (await page.evaluate<string>(`JSON.stringify((() => !Array.from(document.querySelectorAll('[role="menu"]')).find(x => x.getAttribute("data-state") === "open"))())`)) === "true";
              if (!closed) await sleep(100);
            }
            if (!closed) bad(`${p} closes on Escape`, "the menu stayed open");
            else ok(`${p} closes on Escape`);

            // Radix returns focus on unmount, AFTER the close animation, so
            // this must POLL. It was the only check in this file that read
            // document.activeElement once with no settle, and it failed 2 runs
            // out of 3 against a component that was behaving correctly — the
            // sibling search-dialog check right above waits 400ms for exactly
            // this reason. A genuine focus-return defect never converges, so
            // polling cannot hide one; a missing sleep can invent one.
            const back = await (async () => {
              let last = "focus never settled";
              for (let i = 0; i < 40; i++) {
                const r = JSON.parse(await page.evaluate<string>(`JSON.stringify((() => {
                  const el = document.activeElement;
                  const t = document.querySelector("[data-kb-row-menu]");
                  if (t && el && t.contains(el)) return { ok: true, why: "returned to the trigger" };
                  return { ok: false, why: "focus on <" + ((el && el.tagName) || "none").toLowerCase() + ">, not the trigger" };
                })())`)) as { ok: boolean; why: string };
                if (r.ok) return true;
                last = r.why;
                await sleep(50);
              }
              return last;
            })();
            if (back === true) ok(`${p} returns focus to the trigger`);
            else bad(`${p} returns focus to the trigger`, back);
          }
        }
      }
    }

  }

  /* ------------------------------------------------------------------ report */

  await browser.close();
  await server.stop();

  console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

void main().then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1); },
);
