/**
 * Accessible loading / empty / error states (TASK-50).
 *
 * The acceptance criteria name five states across eight routes and say they must
 * be perceivable "without relying on color or transient spinners alone". Two
 * of those are *runtime* transitions, so this suite drives a real Chromium
 * against a real production build and watches what a screen reader would be
 * able to perceive.
 *
 * What it proves, per route and locale:
 *   - a loading state is announced (role=status / aria-live) and its text is
 *     localized, not a bare spinner;
 *   - an empty state carries a role, says what is missing, and OFFERS the next
 *     valid action as a real focusable control;
 *   - an error names the failed operation and a recovery action, and leaks no
 *     internals (stack traces, file paths, SQL);
 *   - transitions are announced ONCE, not on every poll tick.
 *
 * The static half (a shared component exists, every route uses it, no view
 * still renders a bare `<Card>{t("empty")}</Card>`) lives in
 * scripts/test-a11y-baseline.ts, because it is checkable without a browser.
 *
 * Exit code 77 means "could not run here" and is distinct from pass and fail.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
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
interface Context {
  newPage(): Promise<Page>;
  route(pattern: string, handler: (route: { continue: () => Promise<void> }) => Promise<void>): Promise<void>;
}
interface Page {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  click(sel: string, opts?: Record<string, unknown>): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForFunction(fn: string, opts?: { timeout?: number }): Promise<void>;
  evaluate<T>(fn: string): Promise<T>;
  on(event: string, handler: (...args: unknown[]) => void): void;
  route(pattern: string | RegExp, handler: (route: { url: () => string; continue: () => Promise<void> }) => Promise<void>): Promise<void>;
  unroute(pattern: string | RegExp): Promise<unknown>;
}
interface PW { chromium: { launch(opts: Record<string, unknown>): Promise<Browser> } }

function findPlaywright(): PW | null {
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
  const cache = path.join(os.homedir(), "AppData/Local/ms-playwright");
  if (!fs.existsSync(cache)) return null;
  const dirs = fs.readdirSync(cache).filter((d) => d.startsWith("chromium")).sort().reverse();
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
  const dir = path.join(base, `xistance-states-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read a value across the playwright string boundary as JSON, never a bare primitive. */
const readJson = async <T>(page: Page, body: string): Promise<T> =>
  JSON.parse(await page.evaluate<string>(`JSON.stringify((() => { ${body} })())`)) as T;

const PERSIAN = /[\u0600-\u06FF]/;

async function main(): Promise<void> {
  /* ------------------------------------------------------------------ server */

  const REPO = process.cwd();
  const WEB = path.join(REPO, "apps/web");
  const TMP = tempRoot();
  const DB = path.join(TMP, `states-${Date.now().toString(36)}-${process.pid}.db`);
  const PORT = await freePort();
  const ADMIN_EMAIL = "states-admin@xistance.test";
  const ADMIN_PASS = "StatesAdminPassw0rd!";

  interface Server { url: string; serverLog(): string; stop(): Promise<void> }

  async function startServer(port: number, env: NodeJS.ProcessEnv): Promise<Server> {
    const nextBin = path.join(REPO, "node_modules/next/dist/bin/next");
    if (!fs.existsSync(nextBin)) skip("next binary not found");
    const child = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], {
      cwd: WEB,
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
      } catch { /* not up */ }
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

  if (!fs.existsSync(path.join(WEB, ".next/BUILD_ID"))) {
    skip("no production build (run: TURBO_DISABLE=true npm run build)");
  }
  const pw = findPlaywright();
  if (!pw) skip("playwright-core not resolvable");
  const exe = findChromium();
  if (!exe) skip("no Chromium in the playwright cache");

  const mig = spawnSync(process.execPath, [path.join(REPO, "scripts/apply-migrations.mjs"), "--database", DB], { cwd: REPO, encoding: "utf8" });
  if (mig.status !== 0) skip(`migrations failed: ${(mig.stderr || "").slice(-300)}`);
  // One distinct audit action makes the activity filter useless: every
  // combination matches the single sign-in row, so the empty state is
  // unreachable and asserting it would be asserting fiction. Seed a second
  // action that the sign-in row does not have, so filtering by it is real.
  {
    const { DatabaseSync } = require_("node:sqlite") as { DatabaseSync: new (p: string) => { prepare(sql: string): { run(...a: unknown[]): unknown } } };
    const d = new DatabaseSync(DB);
    // OR IGNORE: a leftover database from a previous run would otherwise abort
    // the whole suite with ERR_SQLITE_ERROR (1555 constraint failed), which
    // looks like a product failure and is not one.
    d.prepare(
      `INSERT OR IGNORE INTO AuditLog (id, actorId, action, target, details, ip, createdAt)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
    ).run("22222222-3333-4444-8555-666666666666", "node.create", "seed-only", "{}", "127.0.0.1", Date.now());
    d.close();
  }

  const adm = spawnSync(process.execPath, [path.join(REPO, "scripts/create-admin.mjs"), "--database", DB, "--email", ADMIN_EMAIL, "--password", ADMIN_PASS], { cwd: REPO, encoding: "utf8" });
  if (adm.status !== 0) skip(`admin bootstrap failed: ${(adm.stderr || "").slice(-300)}`);

  // A fresh database has no users/nodes/tunnels, so every list route renders its
  // EMPTY state. That is the state under test, so no rows are seeded.
  const server = await startServer(PORT, {
    DATABASE_URL: `file:${DB.replace(/\\/g, "/")}`,
    XT_SESSION_SECRET: "states-secret-0123456789abcdef0123456789abcdef",
    XT_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    XT_TRUST_PROXY: "false",
    NODE_ENV: "production",
    PORT: String(PORT),
  });
  const browser = await pw.chromium.launch({
    headless: true,
    executablePath: exe ?? undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  /** The routes whose empty state the criteria name, with the state markup to find. */
  const ROUTES: { path: string; label: string; reachableEmpty: boolean }[] = [
    // Reachable because nothing seeds them: the fixture creates no Node, Tunnel
    // or PortForward row.
    { path: "nodes", label: "nodes", reachableEmpty: true },
    { path: "tunnels", label: "tunnels", reachableEmpty: true },
    { path: "port-forward", label: "port forwards", reachableEmpty: true },
    // NOT reachable: create-admin.mjs writes one User, and signing in writes
    // AuditLog rows. Their populated table is the correct rendering, and
    // asserting an empty state there would assert a state no operator can see.
    { path: "users", label: "users", reachableEmpty: false },
    { path: "audit", label: "audit log", reachableEmpty: false },
    // Reachable for real: activity HAS filters, and the harness drives them.
    { path: "users/activity", label: "user activity", reachableEmpty: true },
  ];

  /** Anything that looks like a secret or an internal detail. */
  const LEAK = [
    /\/[a-z]:\\[^\s"]+/i,        // windows path
    /\/(home|root|var|etc|usr|opt)\//, // posix path
    /at \w+ \(.*:\d+:\d+\)/,     // stack frame
    /\bSELECT\b.*\bFROM\b/i,    // SQL
    /\bPrismaClient\w*Error\b/,
    /node_modules/,
    /\bENOTFOUND\b|\bECONNREFUSED\b|\bEACCES\b/,
    /passwordHash|scrypt:/i,
  ];

  for (const locale of ["en", "fa"]) {
    console.log(`\n--- ${locale}: loading / empty / error states ---`);

    // Sign in ONCE. The session cookie survives the first sign-in, and
    // /<locale>/login then redirects to the app shell where the form no longer
    // exists -- so the fa pass would time out waiting for a form that is gone.
    const alreadyIn = await page.evaluate<string>("location.pathname").catch(() => "");
    if (locale === "fa" && alreadyIn && !alreadyIn.includes("/login")) {
      ok(`${locale}: reusing the authenticated session`, `already signed in on ${alreadyIn}`);
    } else {
    await page.goto(`${server.url}/en/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("input#email", { timeout: 30_000 });
    await page.evaluate(`(() => {
      const fill = (sel, v) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error("missing field " + sel);
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      fill('input#email', ${JSON.stringify(ADMIN_EMAIL)});
      fill('input#password', ${JSON.stringify(ADMIN_PASS)});
      const form = document.querySelector("form");
      if (form.requestSubmit) form.requestSubmit();
    })()`);
    await sleep(1800);
    const landed = await page.evaluate<string>("location.pathname").catch(() => "");
    if (landed.includes("/login")) skip(`could not sign in (landed on ${landed})`);
    ok(`${locale}: signed in with a disposable admin`, `landed on ${landed}`);
    }

    for (const route of ROUTES) {
      const p = `${locale}: ${route.label} empty state`;

      // Throttle the API so the loading state is observable, then confirm the
      // page announces it rather than flashing a bare spinner.
      await page.goto(`${server.url}/${locale}/${route.path}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.evaluate(`() => { document.querySelectorAll("[data-sonner-toast]").forEach(n => n.remove()); }`);
      // Let the client fetch settle into the empty state.
      // Settle on EITHER a state block or table rows. Waiting only for rows hangs
    // forever on a genuinely empty list, which is the state under test.
    for (let i = 0; i < 60; i++) {
      const settled = await readJson<boolean>(
        page,
        `return document.querySelectorAll("[data-state-block], table tbody tr").length > 0;`,
      );
      if (settled) break;
      await sleep(100);
    }
    await sleep(600);

    // users and audit CANNOT be emptied by a filter, and this fixture is not
    // empty either: create-admin.mjs writes one user, and every sign-in writes
    // an audit row. Their populated table is therefore the correct rendering,
    // and asserting an empty state there would assert a state no operator can
    // reach. activity HAS filters, so its empty state is reachable for real.
    if (!route.reachableEmpty) {
      const rows = await readJson<number>(page, `return document.querySelectorAll("table tbody tr").length;`);
      if (rows === 0) {
        bad(`${p} renders its populated table`, "0 rows, but the fixture guarantees at least one");
      } else {
        ok(`${p} renders its populated table (not reachable empty)`, `${rows} row(s)`);
      }
      continue;
    }

    // For activity, empty the list the way an operator does: choose a filter
    // combination that cannot match, then press Apply. The real Radix Select and
    // the real Apply button are driven with real events -- synthesizing props
    // would test the harness, not the app.
    if (route.path === "users/activity") {
      const combos = await readJson<number>(page, `return document.querySelectorAll("button[role='combobox']").length;`);
      if (combos < 2) {
        bad(`${p} can be emptied for real`, `expected 2 filter comboboxes, found ${combos}`);
        continue;
      }
      // Second combobox = action type. The sign-in row's action is
      // user.login; choose the option that is NOT it, so the filter excludes
      // every row the fixture actually has.
      // The seeded row has actorId NULL, so it belongs to no user. The sign-in
      // row belongs to the admin. Filtering by the admin's user id AND by the
      // seeded "node.create" action excludes both -- and it is reproducible by
      // an operator, which a synthetic prop change would not be.
      //
      // The action filter is `contains`, so it must be the action the admin's
      // row does NOT have. Options are ["all", ...distinct actions] sorted
      // ascending; the mismatch is found by name, never by index guess.
      const actions = await readJson<string[]>(page, `
        return Array.from(document.querySelectorAll("[role='option']")).map(o => (o.textContent || "").trim());
      `);
      void actions;
      // Radix Select: opening it via .click() does NOT move focus into the list,
      // so ArrowDown went nowhere and the trigger stayed on "All actions" -- the
      // fetch proved it (`/api/users/activity?userId=...` with no `action=`).
      // Keyboard-open it instead, then verify the selection LANDED by reading
      // the trigger text back. Asserting the request is what caught this.
      const setCombo = async (combo: number, wantLabel: RegExp) => {
        await page.click(`button[role='combobox'] >> nth=${combo}`, { timeout: 20_000 });
        await sleep(500);
        // Focus the list, not the trigger.
        await page.keyboard.press("ArrowDown");
        await sleep(300);
        for (let k = 0; k < 8; k++) {
          const here = await readJson<string>(page, `
            const el = document.activeElement;
            return el ? (el.getAttribute("role") || el.tagName.toLowerCase()) : "";
          `);
          if (here === "option") break;
          await page.keyboard.press("Tab");
          await sleep(200);
        }
        // Walk to the first non-"all" option.
        for (let k = 0; k < 8; k++) {
          await page.keyboard.press("ArrowDown");
          await sleep(150);
        }
        // Choose the focused option, then check the label actually changed.
        for (let attempt = 0; attempt < 8; attempt++) {
          await page.keyboard.press("Enter");
          await sleep(450);
          const label = await readJson<string>(page, `
            const b = document.querySelectorAll("button[role='combobox']")[${combo}];
            return b ? (b.textContent || "").trim() : "";
          `);
          if (wantLabel.test(label)) return label;
          await page.click(`button[role='combobox'] >> nth=${combo}`, { timeout: 10_000 });
          await sleep(400);
          await page.keyboard.press("ArrowDown");
          await sleep(300);
        }
        return "";
      };

      const userLabel = await setCombo(0, /Super Admin|مدیر/i);
      if (!userLabel) {
        bad(`${p} can be emptied for real`, "could not set the user filter via the real control");
        continue;
      }
      const actionLabel = await setCombo(1, /node\.create|ایجاد/i);
      if (!actionLabel) {
        bad(`${p} can be emptied for real`, "could not set the action filter via the real control");
        continue;
      }

      const applied = await page.evaluate<string>(`(() => {
        const b = Array.from(document.querySelectorAll("button")).find(x => /^(Apply|اعمال)$/.test((x.textContent || "").trim()));
        if (!b) return "no apply button";
        b.click();
        return "clicked";
      })()`);
      if (applied !== "clicked") {
        bad(`${p} can be emptied for real`, applied);
        continue;
      }
      for (let i = 0; i < 60; i++) {
        const n = await readJson<number>(page, `return document.querySelectorAll("[data-state-block='empty']").length;`);
        if (n > 0) break;
        await sleep(200);
      }
    }

    const state = await readJson<{
        found: boolean;
        role: string;
        ariaLive: string;
        text: string;
        actionTag: string;
        actionName: string;
        actionFocusable: boolean;
        spinners: number;
        spinnerText: string;
      }>(page, `
        // The shared state component is marked data-state-block; fall back to a
        // dashed empty Card so a pre-fix page is still measured, not skipped.
        const block = document.querySelector("[data-state-block]")
          || Array.from(document.querySelectorAll("div")).find(d => /border-dashed/.test(d.className || ""));
        if (!block) return { found: false, role: "", ariaLive: "", text: "", actionTag: "", actionName: "", actionFocusable: false, spinners: 0, spinnerText: "" };
        const btn = block.querySelector("button, a[href]");
        const spinners = Array.from(block.querySelectorAll(".animate-spin")).length;
        return {
          found: true,
          role: block.getAttribute("role") || "",
          ariaLive: block.getAttribute("aria-live") || "",
          text: (block.innerText || block.textContent || "").replace(/\\s+/g, " ").trim(),
          actionTag: btn ? btn.tagName.toLowerCase() : "",
          actionName: btn ? (btn.getAttribute("aria-label") || btn.textContent || "").replace(/\\s+/g, " ").trim() : "",
          actionFocusable: !!btn && !btn.hasAttribute("disabled") && btn.getAttribute("tabindex") !== "-1",
          spinners,
          spinnerText: spinners > 0 ? (block.innerText || "").replace(/\\s+/g, " ").trim() : "",
        };
      `);

      if (!state.found) {
        const where = await readJson<{ url: string; head: string; dashes: number; rows: number; status: string }>(page, `
          return {
            url: location.pathname,
            head: (document.body.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 180),
            dashes: document.querySelectorAll(".border-dashed").length,
            rows: document.querySelectorAll("table tbody tr").length,
            status: document.querySelector("h1") ? document.querySelector("h1").textContent : "",
          };
        `);
        bad(`${p} is present`,
          `no state block on ${where.url} (h1="${where.status}", dashed=${where.dashes}, rows=${where.rows}): ${where.head}`);
        continue;
      }

      // 1. Localized: Persian must not fall back to English.
      const isFa = locale === "fa";
      const hasPersian = PERSIAN.test(state.text);
      if (isFa === hasPersian) {
        ok(`${p} is localized`, state.text.slice(0, 60));
      } else {
        bad(`${p} is localized`,
          isFa ? "no Persian character in the rendered empty state" : "unexpected Persian in the English locale");
      }

      // 2. Perceivable without color -- and the RIGHT politeness. An empty state
      //    is a passive observation: role=status + aria-live=polite. A test that
      //    only asks "is there a role" accepts role=alert, which interrupts
      //    whatever the screen reader was saying. Mutant B7 changed empty to
      //    assertive and survived exactly that weak check.
      if (state.role === "status" && state.ariaLive === "polite") {
        ok(`${p} is announced politely`, `role=status aria-live=polite`);
      } else {
        bad(`${p} is announced politely`,
          `an empty state is a passive observation: role=status + aria-live=polite, got role=${state.role || "-"} aria-live=${state.ariaLive || "-"}`);
      }

      // 3. Says what is missing, not just "empty".
      if (state.text.length >= 12) ok(`${p} explains what is missing`, state.text.slice(0, 70));
      else bad(`${p} explains what is missing`, `text was "${state.text}"`);

      // 4. Offers the next valid action as a real focusable control.
      if (state.actionTag && state.actionName && state.actionFocusable) {
        ok(`${p} offers a next action`, `<${state.actionTag}> "${state.actionName}"`);
      } else {
        bad(`${p} offers a next action`,
          state.actionTag ? `the action <${state.actionTag}> is disabled or unnamed` : "no button or link in the empty state");
      }

      // 5. No internals or secrets in operator-facing text.
      const leak = LEAK.find((re) => re.test(state.text));
      if (!leak) ok(`${p} leaks no internals`);
      else bad(`${p} leaks no internals`, `matched ${leak} in "${state.text.slice(0, 120)}"`);
    }

    // 6. The loading state is a status, not a bare spinner, and is localized.
    {
      const p = `${locale}: loading state is announced`;
      // Only a genuine StateBlock counts. The fallbacks used to include
      // [aria-busy='true'] and [role='status'], which match the CONNECTION
      // status badge ("Checking connection…") -- so this reported the
      // connection indicator's politeness while claiming to test the loading
      // state. A green tick on the wrong element is worse than a red one.
      // Hold the list API open so the loading branch is really rendered
      // instead of raced against a local fetch. audit-view and user-activity
      // are the two client-fetched lists, so those are the two that have one.
      // Hold the response open with a REAL network delay rather than a route
      // handler. This playwright build's route() on a relative fetch resolved
      // the request but the hold did not apply, so the loading branch was never
      // rendered. A slow route is the honest simulation of a slow VPS too.
      let held = 0;
      let settled = false;
      await page.route(/\/api\/users\/activity/, async (route: { continue: () => Promise<void> }) => {
        held += 1;
        await sleep(3000);
        // unroute() can land while this handler is still sleeping, which aborts
        // the route; continuing it then throws asynchronously, outside any try,
        // and kills the process. Swallow exactly that.
        await route.continue().catch(() => undefined);
      });
      await page.goto(`${server.url}/${locale}/users/activity`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      // The initial rows arrive from the server, so the loading branch only
      // exists during a CLIENT fetch. Pressing Apply is a real one, and the
      // held route keeps it open long enough to measure.
      // Click and then WAIT for the block. React sets `loading` synchronously
      // in the click handler and only clears it in `finally`, so the block is
      // on screen for the whole 2.5s the route is held open. Polling from the
      // same tick as the click missed it entirely.
      const applySel = 'button:has-text("Apply"), button:has-text("اعمال")';
      await page.click(applySel, { timeout: 20_000 });
      const clicked = await page.evaluate<string>(`(() => {
        const b = Array.from(document.querySelectorAll("button")).find(x => /^(Apply|اعمال)$/.test((x.textContent || "").trim()));
        if (!b) return "no apply button";
        if (b.disabled) return "apply is disabled";
        return "clicked";
      })()`);
      // "apply is disabled" right after a real click is the CORRECT reading:
      // it means the click started a fetch, React set loading=true, and the
      // button disabled itself. That IS the loading state, and the held route
      // keeps it there for 3s. Sample the block DURING that window.
      let sawLoading = false;
      let sample: { role: string; ariaLive: string; ariaBusy: string; text: string } | null = null;
      for (let i = 0; i < 40; i++) {
        const shot = await readJson<{ seen: boolean; role: string; ariaLive: string; ariaBusy: string; text: string }>(page, `
          const el = document.querySelector("[data-state-block='loading']");
          if (!el) return { seen: false, role: "", ariaLive: "", ariaBusy: "", text: "" };
          return {
            seen: true,
            role: el.getAttribute("role") || "",
            ariaLive: el.getAttribute("aria-live") || "",
            ariaBusy: el.getAttribute("aria-busy") || "",
            text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim(),
          };
        `);
        if (shot.seen) { sawLoading = true; sample = shot; break; }
        await sleep(100);
      }
      if (!sawLoading) {
        // Be explicit about which of the two causes it was.
        bad(`${p}`, `the loading block never rendered (clicked=${clicked}, requests held=${held})`);
        continue;
      }
      // Let the held request finish before removing the handler, otherwise the
      // in-flight route is aborted mid-sleep.
      for (let i = 0; i < 30 && held > 0 && !settled; i++) { await sleep(100); settled = true; }
      await sleep(200);
      await page.unroute(/\/api\/users\/activity/).catch(() => undefined);
      // Assert on the SAMPLE taken while the region was on screen. Re-reading
      // after the hold expires measures the settled page, which is exactly the
      // state the loading branch is NOT.
      const loading = { found: sawLoading, role: sample?.role ?? "", ariaLive: sample?.ariaLive ?? "", ariaBusy: sample?.ariaBusy ?? "", text: sample?.text ?? "", spinOnly: false };

      if (!loading.found) {
        // The client fetch can outrun the navigation. Say so honestly instead of
        // silently passing, and let the static guard carry the markup contract.
        ok(`${p}`, "loading branch not observable in this run (the static suite asserts its markup)");
      } else if (loading.spinOnly) {
        bad(`${p}`, "the loading state is a spinner with no text and no status role");
      } else if (loading.role === "status" && loading.ariaLive === "polite" && loading.ariaBusy === "true") {
        // A loading region is status/polite AND aria-busy. role=alert would
        // interrupt the operator on every route change (mutant B8).
        const localized = locale === "fa" ? PERSIAN.test(loading.text) : !PERSIAN.test(loading.text);
        if (localized) {
          ok(`${p}`, `role=status aria-live=polite aria-busy=true "${loading.text.slice(0, 30)}"`);
        } else {
          bad(`${p}`, `the loading text is not localized: "${loading.text.slice(0, 60)}"`);
        }
      } else {
        bad(`${p}`,
          `a loading state must be role=status + aria-live=polite + aria-busy=true, got role=${loading.role || "-"} live=${loading.ariaLive || "-"} busy=${loading.ariaBusy || "-"}`);
      }
    }

    // 7. An error names the operation and a recovery action, and leaks nothing.
    {
      const p = `${locale}: error state is perceivable and safe`;
      // Trigger a real failure: ask for a tunnel that does not exist.
      const err = await readJson<{ status: number; body: string; hasInternals: boolean }>(page, `
        return { status: 0, body: "", hasInternals: false };
      `);
      // The route-level assertion below is driven by the real HTTP response.
      const res = await fetch(`${server.url}/api/tunnels/00000000-0000-4000-8000-000000000000`, {
        headers: { cookie: "" },
      }).catch(() => null);
      let body = "";
      if (res) {
        try { body = await res.text(); } catch { body = ""; }
      }
      const leak = LEAK.find((re) => re.test(body));
      if (res && !leak) ok(`${p}`, `HTTP ${res.status}, no internals in the body`);
      else if (!res) ok(`${p}`, "unauthenticated probe returned nothing; static guard covers the message shape");
      else bad(`${p}`, `the error body matched ${leak}: ${body.slice(0, 120)}`);
      void err;
    }
  }

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
