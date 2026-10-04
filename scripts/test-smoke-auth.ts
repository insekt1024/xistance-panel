/**
 * Browser smoke suite: login and dashboard (TASK-51).
 *
 * The gate for the whole browser chain (TASK-52 -> 53 -> 54 -> 48), and the
 * first suite here that walks a full user journey end to end rather than
 * probing one surface:
 *
 *   disposable local DB -> login failure -> login success -> protected route
 *   redirect -> session refresh -> dashboard load -> every static asset
 *   actually loads -> logout -> protected route redirects again
 *
 * Two things this suite is specifically built to catch, because both have been
 * real defects in this repo:
 *
 *  - **A session cookie that lies.** "Logged in" is not the same as "the server
 *    agrees". Every protected step re-checks with the SERVER, not with the DOM.
 *  - **A page that renders but is not usable.** A missing `.next/static` bundle
 *    yields HTML that looks fine and a blank screen. Every requested asset is
 *    recorded with its status and content-type, and a 404 or a `text/html`
 *    where JavaScript was expected is a failure.
 *
 * No real credentials are used: the database is created in a temp directory, and
 * the admin is created by the same script the installer uses. Secrets in this
 * file are throwaway values for a throwaway database.
 *
 * Exit 77 = could not run here (distinct from pass and fail).
 */

import { findChromiumExecutable } from "./lib/chromium-path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./lib/browser-harness";
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
  cookies(): Promise<{ name: string; value: string }[]>;
}
interface Page {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  click(sel: string, opts?: Record<string, unknown>): Promise<void>;
  fill(sel: string, value: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
  on(event: string, handler: (...args: unknown[]) => void): void;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read a value across the playwright string boundary as JSON, never a bare primitive. */
/* ------------------------------------------------------------------ server */

const REPO = process.cwd();
const WEB = path.join(REPO, "apps/web");
const ADMIN_EMAIL = "smoke-admin@xistance.invalid";
const ADMIN_PASS = "SmokeAdminPassw0rd!";

/**
 * Control labels come from the message catalogs, never from a hardcoded guess.
 * The first version matched /^(Log out|Log Out|خروج)$/ and reported "no logout
 * control exists" -- while the menu, open on screen, read "Sign out". A test that
 * invents a label string tests its own memory of the UI, not the UI.
 */
async function cookieHeader(ctx: { cookies(): Promise<Array<{ name: string; value: string }>> }): Promise<string> {
  const cs = await ctx.cookies();
  return cs.map((c) => `${c.name}=${c.value}`).join("; ");
}

function labels(loc: string, group: string, key: string): string {
  const f = path.join(REPO, "packages/i18n/messages", `${loc}.json`);
  return (JSON.parse(fs.readFileSync(f, "utf8"))[group]?.[key] ?? "") as string;
}

// `PORT` and `TMP` need `await` and a per-run name, and this file is transpiled
// to CJS where top-level await does not exist -- so they are created inside
// main() rather than at module scope. Getting this wrong is a TS/esbuild
// transform error, not a runtime one.
async function main(): Promise<void> {
  const baseTmp = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? os.tmpdir();
  assert.ok(baseTmp, "a temporary directory is required");
  const TMP = path.join(baseTmp, `xistance-smoke-${Date.now().toString(36)}-${process.pid}`);
  const DB = path.join(TMP, "smoke.db");
  const PORT = await freePort();
  fs.mkdirSync(TMP, { recursive: true });

  if (!fs.existsSync(path.join(WEB, ".next/BUILD_ID"))) {
    skip("no production build (run: TURBO_DISABLE=true npm run build)");
  }
  const pw = findPlaywright();
  if (!pw) skip("playwright-core not resolvable");
  const exe = findChromium();
  if (!exe) skip("no Chromium in the playwright cache");

  const nextBin = path.join(REPO, "node_modules/next/dist/bin/next");
  if (!fs.existsSync(nextBin)) skip("next binary not found");

  // Disposable database. Nothing here touches a real installation.
  const mig = spawnSync(process.execPath, [path.join(REPO, "scripts/apply-migrations.mjs"), "--database", DB], {
    cwd: REPO, encoding: "utf8",
  });
  if (mig.status !== 0) skip(`migrations failed: ${(mig.stderr || "").slice(-300)}`);
  const adm = spawnSync(process.execPath, [
    path.join(REPO, "scripts/create-admin.mjs"), "--database", DB,
    "--email", ADMIN_EMAIL, "--password", ADMIN_PASS,
  ], { cwd: REPO, encoding: "utf8" });
  if (adm.status !== 0) skip(`admin bootstrap failed: ${(adm.stderr || "").slice(-300)}`);


  /**
   * Insert one fresh AuditLog row straight into the suite's disposable database.
   *
   * Raw SQLite has to match Prisma's storage semantics exactly, or the very next
   * Prisma read fails with "Inconsistent column data": the id is a UUID string
   * and createdAt is INTEGER milliseconds -- NOT an ISO string.
   */
  const seedActivityRow = async (): Promise<boolean> => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(DB);
    try {
      const cols = db.prepare("PRAGMA table_info('AuditLog')").all() as Array<{ name: string }>;
      const names = cols.map((c) => c.name);
      const has = (n: string): boolean => names.includes(n);
      const vals: Record<string, string | number> = {
        id: randomUUID(),
        action: "node.create",
        target: "smoke-probe",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (has("userId")) vals.userId = "";
      const use = Object.keys(vals).filter(has);
      db.prepare(`INSERT INTO "AuditLog" (${use.map((k) => `"${k}"`).join(", ")}) VALUES (${use.map(() => "?").join(", ")})`)
        .run(...use.map((k) => vals[k]));
      return true;
    } catch (e) {
      console.error("       [seed] " + String(e).slice(0, 200));
      return false;
    } finally {
      db.close();
    }
  };

  // `next start` from apps/web, NOT the standalone server: the standalone server
  // bundles its own Prisma client, so a database created by apply-migrations.mjs
  // is invisible to it and every login fails with a misleading "invalid
  // credentials". That cost an hour once.
  const child: ChildProcess = spawn(process.execPath, [nextBin, "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    cwd: WEB,
    env: {
      ...process.env,
      DATABASE_URL: `file:${DB.replace(/\\/g, "/")}`,
      XT_SESSION_SECRET: "smoke-secret-0123456789abcdef0123456789abcdef",
      XT_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      XT_TRUST_PROXY: "false",
      NODE_ENV: "production",
      PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout?.on("data", (d) => { serverLog += String(d); });
  child.stderr?.on("data", (d) => { serverLog += String(d); });

  const origin = `http://127.0.0.1:${PORT}`;
  let up = false;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${origin}/api/health`);
      if (r.ok) { up = true; break; }
    } catch { /* not up yet */ }
    if (child.exitCode !== null) skip(`server exited (${child.exitCode}): ${serverLog.slice(-500)}`);
    await sleep(250);
  }
  if (!up) skip(`server never became healthy: ${serverLog.slice(-500)}`);

  const stopServer = async (): Promise<void> => {
    await new Promise<void>((res) => {
      child.once("exit", () => res());
      child.kill("SIGTERM");
      setTimeout(() => { child.kill("SIGKILL"); res(); }, 4000);
    });
  };

  const browser = await pw.chromium.launch({
    headless: true,
    executablePath: exe ?? undefined,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  /* Every network response the page makes, so a 404 bundle is visible. */
  const assets: { url: string; status: number; type: string; kind: string }[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("response", ((res: { url: () => string; status: () => number; headers: Record<string, string> }) => {
    const u = res.url();
    if (!u.startsWith(origin)) return;
    const pathname = u.slice(origin.length);
    let kind = "other";
    if (pathname.startsWith("/_next/static/")) kind = "static";
    else if (pathname.startsWith("/api/")) kind = "api";
    else if (/\.(svg|png|jpe?g|gif|webp|ico|woff2?|ttf|mp4|webm|css|js)$/.test(pathname)) kind = "public";
    if (kind === "other") return;
    assets.push({ url: pathname, status: res.status(), type: res.headers()["content-type"] || "", kind });
  }) as (...args: unknown[]) => void);
  page.on("console", ((msg: { type: () => string; text: () => string }) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  }) as (...args: unknown[]) => void);
  let where = "(before navigation)";
  page.on("pageerror", ((err: { message: string }) => { pageErrors.push(`${err.message} @ ${where}`); }) as (...args: unknown[]) => void);
  page.on("framenavigated", ((f: { url: () => string }) => {
    const u = f.url();
    if (u.startsWith(origin)) where = u.slice(origin.length);
  }) as (...args: unknown[]) => void);

  /**
   * Ask the SERVER, not the DOM: a stale cookie next to a rendered shell is the
   * exact failure mode this has to catch.
   *
   * The first version used POST /api/auth/refresh, which turned out to be the
   * wrong instrument twice over. It returns 401 both when the session is gone
   * AND when the CSRF header is missing, so a logout that silently failed 403
   * looked identical to a logout that worked -- which is exactly why the
   * shipped raw-fetch bug SURVIVED this test. M1 now dies.
   *
   * A protected page has no such ambiguity: a real session yields 200, a revoked
   * one yields the /login redirect. The status code is returned so a failure
   * can say WHICH answer it got.
   */
  const serverSeesSession = async (): Promise<{ live: boolean; how: string }> => {
    // Read the BODY, not just the status. A 401 with a JSON error is
    // unambiguous, whereas `redirect: "manual"` yields an opaque status that can
    // read as anything -- and the first version of this check reported "revoked"
    // for a session that was very much alive, because the raw-fetch logout (M1)
    // leaves the cookies in place.
    const r = await page.evaluate<string>(`(async () => {
      const res = await fetch("/api/nodes", { credentials: "include" });
      let body = "";
      try { body = (await res.text()).slice(0, 120); } catch { body = "<unreadable>"; }
      return res.status + " :: " + body;
    })()`);
    return { live: r.startsWith("200"), how: `GET /api/nodes -> ${r}` };
  };

  try {
    /* ---------------------------------------------------- 1. protected route */
    console.log("\n--- protected routes redirect an anonymous visitor ---");
    // There is NO /dashboard route: the (app) group root is the dashboard.
    // Asserting a 404 page here would have been a harness bug reading as a
    // product failure, and asserting a 404 renders would have been worse.
    for (const p of ["/en", "/en/nodes", "/en/tunnels", "/en/settings"]) {
      await page.goto(`${origin}${p}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(500);
      const at = await readJson<string>(page, "return location.pathname;");
      if (at.endsWith("/login")) {
        ok(`anonymous ${p} redirects to login`, at);
      } else {
        bad(`anonymous ${p} redirects to login`, `it rendered ${at} instead`);
      }
    }

    /* ------------------------------------------------------- 2. login page */
    console.log("\n--- the login page itself ---");
    await page.goto(`${origin}/en/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("input#email", { timeout: 30_000 });

    const form = await readJson<{
      hasCsrfCookie: boolean;
      emailLabel: string;
      passwordLabel: string;
      emailAutocomplete: string;
      passwordAutocomplete: string;
      submitText: string;
      imagesWithoutAlt: number;
    }>(page, `
      const lab = (id) => {
        const l = document.querySelector('label[for="' + id + '"]');
        return l ? (l.textContent || "").trim() : "";
      };
      const submit = document.querySelector('button[type="submit"]') || Array.from(document.querySelectorAll("button")).pop();
      return {
        hasCsrfCookie: /xt_csrf=/.test(document.cookie),
        emailLabel: lab("email"),
        passwordLabel: lab("password"),
        emailAutocomplete: (document.querySelector("#email") || {}).autocomplete || "",
        passwordAutocomplete: (document.querySelector("#password") || {}).autocomplete || "",
        submitText: submit ? (submit.textContent || "").trim() : "",
        imagesWithoutAlt: Array.from(document.images).filter(i => !i.hasAttribute("alt")).length,
      };
    `);
    // This one is deliberately NOT httpOnly: `apiFetch` reads it to populate
    // X-CSRF-Token, and the double-submit pattern only works if the browser can
    // see it. I initially asserted the opposite and it was wrong -- the check
    // has to be "the server issues it and the client uses it", not "it is
    // invisible". An httpOnly CSRF cookie here would break every mutation.
    //
    // The real risk this guards is the OTHER half: the token must be required.
    // That is asserted below by rejecting a mutation with no header at all.
    // The CSRF cookie is minted by createSession(), i.e. BY the login response --
    // it is deliberately absent on the anonymous login page. So "is it in
    // document.cookie yet?" is the wrong question at this point in the journey.
    // The two questions that matter are asked at the right moments instead:
    //   (a) after login, is it present and JS-readable?  (below)
    //   (b) is it actually REQUIRED?                     (later, the no-header probe)
    if (form.emailLabel && form.passwordLabel) ok("both fields have visible labels", `${form.emailLabel} / ${form.passwordLabel}`);
    else bad("both fields have visible labels", `email="${form.emailLabel}" password="${form.passwordLabel}"`);
    if (form.emailAutocomplete === "email" && form.passwordAutocomplete === "current-password") {
      ok("autocomplete hints are correct", `${form.emailAutocomplete} / ${form.passwordAutocomplete}`);
    } else {
      bad("autocomplete hints are correct", `${form.emailAutocomplete} / ${form.passwordAutocomplete}`);
    }
    if (form.submitText) ok("the submit button is named", form.submitText);
    else bad("the submit button is named", "no text on the submit control");
    if (form.imagesWithoutAlt === 0) ok("every image on the login page has an alt attribute");
    else bad("every image on the login page has an alt attribute", `${form.imagesWithoutAlt} image(s) without alt`);

    /* ------------------------------------------------ 3. login FAILS wrong */
    console.log("\n--- a wrong password is rejected, accessibly ---");
    await page.fill("input#email", ADMIN_EMAIL);
    await page.fill("input#password", "definitely-not-the-password");
    await page.click('button[type="submit"]');
    // Wait for the alert to EXIST, not for "some live region on the page".
    // The navbar's connection indicator is already an aria-live region, so the
    // old predicate was satisfied before the request was ever sent.
    let alertText = "";
    for (let i = 0; i < 60; i++) {
      alertText = await readJson<string>(page, `
        const a = document.querySelector('[role="alert"]');
        return a ? (a.textContent || "").replace(/\s+/g, " ").trim() : "";
      `);
      if (alertText) break;
      await sleep(150);
    }
    const failed = await readJson<{ stillOnLogin: boolean; alertText: string; alertIsAssertive: boolean; sessionWorks: boolean }>(page, `
      const a = document.querySelector('[role="alert"]') || Array.from(document.querySelectorAll("p,div")).find(el => el.getAttribute("aria-live") === "assertive");
      return {
        stillOnLogin: /\\/login/.test(location.pathname),
        alertText: a ? (a.textContent || "").replace(/\\s+/g, " ").trim() : "",
        alertIsAssertive: !!a,
        sessionWorks: false,
      };
    `);
    if (failed.stillOnLogin) ok("a wrong password keeps the user on the login page");
    else bad("a wrong password keeps the user on the login page", `navigated to ${origin}`);
    if (alertText) ok("the failure is announced in a role=alert region", alertText.slice(0, 60));
    else bad("the failure is announced in a role=alert region",
      "after a rejected login no [role=alert] existed; the error was only ever a transient toast, which a screen reader may never announce");
    if (!(await serverSeesSession()).live) ok("a failed login grants no server-side session");
    else bad("a failed login grants no server-side session", "the server accepted a session after a wrong password");

    /* ------------------------------------------------ 4. login SUCCEEDS */
    console.log("\n--- a correct password signs in ---");
    await page.fill("input#email", ADMIN_EMAIL);
    await page.fill("input#password", ADMIN_PASS);
    await page.click('button[type="submit"]');
    for (let i = 0; i < 60; i++) {
      const at = await readJson<string>(page, "return location.pathname;").catch(() => "x");
      if (!at.includes("/login")) break;
      await sleep(200);
    }
    const after = await readJson<string>(page, "return location.pathname;");
    if (!after.includes("/login")) ok("login navigates into the app", after);
    else bad("login navigates into the app", `still on ${after}`);
    if ((await serverSeesSession()).live) ok("the server confirms the session");
    else bad("the server confirms the session", "/api/auth/refresh rejected a session the UI considered logged in");

    /* ------------------------------------------------- 5. session refresh */
    console.log("\n--- the session refreshes and survives a reload ---");
    await page.goto(`${origin}/en/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(1200);
    const bouncedBack = await readJson<string>(page, "return location.pathname;");
    if (!bouncedBack.includes("/login")) {
      ok("an authenticated visit to /login is sent into the app", bouncedBack);
    } else {
      bad("an authenticated visit to /login is sent into the app", "it stayed on the login page despite a valid session");
    }
    await page.goto(`${origin}/en`, { waitUntil: "networkidle", timeout: 60_000 });
    const afterReload = await readJson<string>(page, "return location.pathname;");
    if (!afterReload.includes("/login")) ok("a full page reload keeps the session", afterReload);
    else bad("a full page reload keeps the session", `bounced to ${afterReload}`);

    /* --------------------------------------------------- 6. dashboard load */
    // ---- the login page's own accessibility surface -------------------
    const loginA11y = await readJson<{ labels: number; unnamed: string[]; alerts: number; lang: string; dir: string }>(page, `
      const ctrls = Array.from(document.querySelectorAll("input:not([type=hidden]), select, textarea"));
      const unnamed = ctrls.filter(c => {
        const id = c.getAttribute("id");
        const lbl = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
        return !lbl && !c.getAttribute("aria-label") && !c.getAttribute("aria-labelledby");
      }).map(c => c.getAttribute("name") || c.tagName);
      return {
        labels: ctrls.length,
        unnamed,
        alerts: document.querySelectorAll('[role="alert"]').length,
        lang: document.documentElement.lang,
        dir: document.documentElement.dir || "(none)",
      };
    `);
    // At this point we are AUTHENTICATED, so there is no login form here at all.
    // Asserting "all login fields are named" against this page measured nothing.
    // The real version of this check runs after logout, on /login, and fails if
    // it cannot find at least two controls -- so a broken selector cannot pass
    // quietly. Here we only assert what this page can actually tell us.
    if (loginA11y.labels === 0) {
      ok("the authenticated dashboard exposes no stray form fields");
    } else {
      bad("the authenticated dashboard exposes no stray form fields",
        `${loginA11y.labels} control(s) leaked onto the dashboard: ${loginA11y.unnamed.join(", ") || "(all named)"}`);
    }
    if (loginA11y.lang === "fa" ? loginA11y.dir === "rtl" : loginA11y.dir !== "rtl") {
      ok(`document direction follows the locale (lang=${loginA11y.lang} dir=${loginA11y.dir})`);
    } else {
      bad("document direction follows the locale",
        `lang=${loginA11y.lang} dir=${loginA11y.dir} -- Persian text laid out left-to-right`);
    }

    console.log("\n--- after login ---");
    // (a) After login the CSRF cookie must exist and be JS-readable -- the
    //     double-submit pattern only works if the browser can echo it in a
    //     header. It is set with httpOnly:false on purpose, so this is a real
    //     assertion rather than an accident of the cookie store.
    const afterLogin = await readJson<{ hasCsrf: boolean; cookies: string[] }>(page, `
      const names = document.cookie.split(";").map(c => c.split("=")[0].trim()).filter(Boolean);
      return { hasCsrf: /xt_csrf=/.test(document.cookie), cookies: names };
    `);
    if (afterLogin.hasCsrf) {
      ok(`after login the CSRF cookie is present and JS-readable (cookies: ${afterLogin.cookies.join(", ")})`);
    } else {
      bad("after login the CSRF cookie is present and JS-readable",
        `no xt_csrf cookie after a successful login (saw: ${afterLogin.cookies.join(", ")}), so apiFetch cannot build X-CSRF-Token and every mutation is rejected`);
    }

    // (b) The other half of double-submit: the token must actually be REQUIRED.
    //     Issued-but-unenforced is worse than either, because it looks secure in
    //     a code review. Send a real state-changing request with the session
    //     cookie but NO X-CSRF-Token and require a 403 from the server.
    const noHeader = await (await fetch(`${origin}/api/nodes`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie: await cookieHeader(ctx) },
      body: JSON.stringify({ name: "csrf-probe", host: "127.0.0.1", port: 22 }),
    })).status;
    if (noHeader === 403) ok("a mutation without X-CSRF-Token is refused with 403");
    else bad("a mutation without X-CSRF-Token is refused with 403",
      `the server answered ${noHeader}; the CSRF cookie is minted but not enforced, so a cross-site POST would succeed`);

    // The activity panel is empty with a fresh database, so any relative-time
    // assertion would pass vacuously. Seed one recent audit row first, and FAIL
    // loudly if no relative-time text appears -- otherwise a broken selector
    // reports "nothing to check" as a pass.
    const seeded = await seedActivityRow();
    if (!seeded) {
      bad("a recent activity row renders a relative time", "could not seed an audit row");
    } else {
      await page.reload({ waitUntil: "networkidle", timeout: 60_000 });
      // Match on the RENDERED text rather than a class: the class list changed
      // once already and the assertion silently stopped finding anything.
      // Collect the activity panel's stamps WITHOUT filtering on what they say.
      // The previous version filtered for now/minutes/hours/days, so a frozen
      // clock ("56 years ago") produced an EMPTY list -- and then the decay check
      // below ran over that empty list and passed. Both assertions were vacuous
      // at once, which is worse than one.
      const stamps = await readJson<string[]>(page, `
        const panel = document.querySelector('[data-testid="activity-panel"]');
        if (!panel) return [];
        const spans = panel.querySelectorAll("span.tabular-nums");
        return Array.from(spans).map(el => (el.textContent || "").replace(/\\s+/g, " ").trim()).filter(Boolean).slice(0, 6);
      `);
      if (stamps.length === 0) {
        bad("a recent activity row renders a relative time",
          "the seeded audit row produced no timestamp; both clock assertions below would be vacuous");
      } else {
        ok(`a recent activity row renders a relative time (${stamps.join(" | ")})`);
      }

      // The clock must be REAL and SHARED per entry. Two distinct defects hide
      // here, and one assertion cannot see both:
      //
      //   (a) frozen at the epoch  -> every stamp reads "56 years ago"
      //   (b) a single frozen read -> every stamp reads "now", because one
      //       constant is subtracted from every entry at once.
      //
      // (b) is why the first version of this check survived: the seeded rows are
      // seconds apart, so pinning the clock flattens "now | 2s ago | 3s ago"
      // into "now | now | now". A non-empty list of plausible-looking stamps is
      // NOT evidence that the clock is being read. Require the DISTINCT ages.
      const decayed = stamps.filter((t) => /(decade|year|سال|دهه)/i.test(t));
      const distinct = new Set(stamps.map((t) => t.trim().toLowerCase()));
      if (stamps.length === 0) {
        bad("relative timestamps come from a real, per-entry clock", "no stamps to inspect");
      } else if (decayed.length > 0) {
        bad("relative timestamps come from a real, per-entry clock",
          `a stamp reads like "${decayed[0]}" -- the clock was pinned to the epoch`);
      } else if (stamps.length > 1 && distinct.size === 1) {
        bad("relative timestamps come from a real, per-entry clock",
          `all ${stamps.length} stamps are identical ("${stamps[0]}") although the rows are seconds apart -- one constant clock is being applied to every entry`);
      } else {
        ok(`relative timestamps come from a real, per-entry clock (${stamps.join(" | ")})`);
      }
    }

    // ---- the health tooltip must follow the writing direction --------------
    // The component mixes a logical offset (me-2) with its anchor. A physical
    // anchor pins the tooltip to the same edge in BOTH directions, so in Persian
    // it is pushed out through the wrong side of the navbar.
    //
    // The invariant is not "which edge" but "the edge FLIPS with the locale":
    // one measurement is meaningless, the pair is not. A physical anchor passes
    // in English -- which is exactly how the original defect shipped.
    const TIP_PROBE = `
      const status = document.querySelector('[role="status"][class*="sr-only"]');
      const scope = status ? status.parentElement : null;
      const el = scope ? scope.querySelector("span.whitespace-nowrap") : null;
      if (!el || !scope) return { side: "none", l: -1, r: -1 };
      const hr = scope.getBoundingClientRect();
      const tr = el.getBoundingClientRect();
      // Which physical side of the host box the tooltip occupies.
      const side = tr.left >= hr.right - 1 ? "right" : tr.right <= hr.left + 1 ? "left" : "overlap";
      return { side, l: Math.round(tr.left - hr.left), r: Math.round(tr.left - hr.right) };
    `;
    const tipEn = await readJson<{ side: string; l: number; r: number }>(page, TIP_PROBE);

    await page.goto(`${origin}/fa`, { waitUntil: "networkidle", timeout: 60_000 });
    await sleep(400);
    const tipFa = await readJson<{ side: string; l: number; r: number }>(page, TIP_PROBE);
    // Back to English for the remaining checks.
    await page.goto(`${origin}/en`, { waitUntil: "networkidle", timeout: 60_000 });
    await sleep(400);

    if (tipEn.side === "none" || tipFa.side === "none") {
      ok("the health tooltip was not rendered, so there is nothing to anchor");
    } else if (tipEn.side !== "left" && tipEn.side !== "right") {
      bad("the health tooltip follows the writing direction",
        `in en the tooltip was "${tipEn.side}" the host, so it cannot be anchored to an edge at all`);
    } else if (tipFa.side === tipEn.side) {
      bad("the health tooltip follows the writing direction",
        `the tooltip sat on the SAME side (${tipEn.side}) in en and fa -- the anchor is physical, so Persian points the wrong way`);
    } else {
      ok(`the health tooltip flips with the writing direction (en: ${tipEn.side}, fa: ${tipFa.side})`);
    }

    console.log("\n--- the dashboard renders ---");
    if (process.env.SMOKE_DEBUG) {
      const serverHtml = await (await fetch(`${origin}/en`, { headers: { cookie: (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ") } })).text();
      const domText = await readJson<string>(page, "return (document.body.innerText || '').replace(/\\s+/g, ' ').trim();");
      const strip = (h: string) => (h.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[^;]+;/g, " ").replace(/\s+/g, " ").trim());
      const sv = strip(serverHtml);
      console.log("       [dbg] server text: " + sv.slice(0, 220));
      console.log("       [dbg] client text: " + domText.slice(0, 220));
      // Find the first divergence between the two renderings.
      for (let i = 0; i < Math.max(sv.length, domText.length); i++) {
        if (sv[i] !== domText[i]) {
          console.log("       [dbg] first divergence at " + i + ": server=..." + sv.slice(Math.max(0, i - 40), i + 40) + "... client=..." + domText.slice(Math.max(0, i - 40), i + 40) + "...");
          break;
        }
      }
    }
    const dash = await readJson<{
      heading: string;
      cards: number;
      hasLoginForm: boolean;
      hasErrorBoundary: boolean;
      bodyLength: number;
    }>(page, `
      const h1 = document.querySelector("h1");
      return {
        heading: h1 ? (h1.textContent || "").trim() : "",
        cards: document.querySelectorAll("[data-slot='card'], .rounded-lg.border").length,
        hasLoginForm: !!document.querySelector("#password"),
        hasErrorBoundary: /Application error|Internal Server Error|unhandled/i.test(document.body.innerText || ""),
        bodyLength: (document.body.innerText || "").trim().length,
      };
    `);
    if (dash.heading) ok("the dashboard has a heading", dash.heading);
    else bad("the dashboard has a heading", "no <h1> rendered");
    if (!dash.hasLoginForm) ok("the dashboard is not showing the login form");
    else bad("the dashboard is not showing the login form", "the password field is present on /dashboard");
    if (!dash.hasErrorBoundary && dash.bodyLength > 40) {
      ok("the dashboard rendered content, not an error boundary", `${dash.bodyLength} chars, ${dash.cards} card(s)`);
    } else {
      bad("the dashboard rendered content, not an error boundary",
        `error=${dash.hasErrorBoundary} bodyLength=${dash.bodyLength}`);
    }

    /* ---------------------------------------------------- 7. static assets */
    console.log("\n--- every static asset actually loads ---");
    // Give the app a moment to finish its chunk requests.
    await sleep(1200);
    const staticAssets = assets.filter((a) => a.kind === "static" || a.kind === "public");
    if (staticAssets.length === 0) {
      bad("every static asset actually loads", "the page requested no static or public assets at all — a missing .next/static looks exactly like this");
    } else {
      const broken = staticAssets.filter((a) => a.status >= 400);
      const wrongType = staticAssets.filter(
        (a) => a.url.endsWith(".js") && /text\/html/.test(a.type),
      );
      if (broken.length === 0 && wrongType.length === 0) {
        ok("every static asset actually loads", `${staticAssets.length} asset(s), all 2xx with the right content-type`);
      } else if (broken.length > 0) {
        bad("every static asset actually loads",
          `${broken.length} broken: ` + broken.slice(0, 5).map((a) => `${a.status} ${a.url}`).join(", "));
      } else {
        bad("every static asset actually loads",
          `${wrongType.length} served as HTML instead of JavaScript: ` + wrongType.slice(0, 3).map((a) => a.url).join(", "));
      }
    }

    /* ------------------------------------------------------ 8. no console errors */
    console.log("\n--- no uncaught page or console errors ---");
    // Sonner and Next's dev-only hints are not defects.
    const realConsole = consoleErrors.filter(
      (t) => !/Download the React DevTools|was preloaded using link preload|socket\.io|Failed to load resource: the server responded with a status of 4\d\d/i.test(t),
    );
    // A hydration mismatch is React's #418. It is not a cosmetic warning: React
    // discards the server's markup for that subtree and re-renders on the
    // client, so first paint can flash the wrong content. The cause here was a
    // client component computing "x minutes ago" from Date.now() during render.
    if (pageErrors.length === 0) ok("no uncaught exceptions");
    else {
      // A minified React #418 is "hydration failed because the server HTML did
      // not match the client". That names a symptom, not a node, so capture the
      // surrounding DOM instead of guessing which component diverges.
      const ctx2 = await readJson<{ body: string; url: string }>(page, `
        return { body: (document.body.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 300), url: location.pathname };
      `);
      bad("no uncaught exceptions",
        `${pageErrors.slice(0, 2).join(" | ")}\n       (on ${ctx2.url}: ${ctx2.body})`);
    }
    if (realConsole.length === 0) ok("no console errors", `${consoleErrors.length} suppressed hint(s)`);
    else bad("no console errors", realConsole.slice(0, 3).join(" | "));

    /* ------------------------------------------------------------ 9. logout */
    console.log("\n--- logout revokes the session for real ---");
    // The logout control lives in the account dropdown, so open it first with a
    // real click. Looking for the menu item on a closed menu finds nothing, and
    // the previous version reported "no logout control exists" -- which reads
    // like the app has no way to sign out.
    // Both locales' labels, read from the catalogs, so the suite is not tied to
    // one translation.
    const WANT_LABELS = [labels("en", "common", "logout"), labels("fa", "common", "logout")].join("|");
    const ACCOUNT_LABELS = [labels("en", "nav", "accountMenu"), labels("fa", "nav", "accountMenu")].join("|");
    const opened = await page.evaluate<string>(`(() => {
      const btns = Array.from(document.querySelectorAll("header button, nav button, [class*='rounded-full']"));
      const named = btns.map(b => (b.getAttribute("aria-label") || (b.textContent || "").trim()).replace(/\s+/g, " ")).filter(Boolean);
      return named.join(" | ");
    })()`);
    // The trigger is clicked by its stable test hook, NOT by its accessible name,
    // so that a naming regression fails the naming ASSERTION instead of breaking
    // the click (which would report "no logout control" for the wrong reason).
    const acctName = await readJson<string>(page, `
      const el = document.querySelector('[data-testid="account-menu-trigger"]');
      if (!el) return "<no trigger>";
      return (el.getAttribute("aria-label") || "").trim();
    `);
    if (acctName && (ACCOUNT_LABELS.split("|").filter(Boolean) as string[]).includes(acctName)) {
      ok(`the account trigger has an accessible name — "${acctName}"`);
    } else {
      bad("the account trigger has an accessible name",
        `aria-label was ${acctName ? JSON.stringify(acctName) : "absent"}; a screen reader would announce only the avatar initial`);
    }
    const acctSel = '[data-testid="account-menu-trigger"]';
    await page.click(acctSel, { timeout: 15_000 })
      .catch((e: unknown) => { void e; });
    await sleep(700);
    // readJson's function is evaluated IN THE BROWSER, so it cannot close over
    // Node-scope variables. The label has to be interpolated into the source text.
    // Watch the network: the click MUST produce a logout request that carries
    // X-CSRF-Token. A raw fetch omits the header, the server answers 403, and
    // the user is redirected to /login while still holding a live session.
    // This is the probe a CLIENT-side mutation can actually kill -- the direct
    // 403 probe below proves the server's rule but is blind to the navbar.
    const reqs: Array<{ url: string; hasCsrf: boolean; status: number }> = [];
    const onReq = (r: { url(): string; headers(): Record<string, string> }): void => {
      if (r.url().includes("/api/auth/logout")) {
        const h = r.headers();
        reqs.push({ url: r.url(), hasCsrf: Object.keys(h).some((k) => k.toLowerCase() === "x-csrf-token"), status: 0 });
      }
    };
    page.on("request", onReq as (x: unknown) => void);
    const onResp = (r: { url(): string; status(): number; request(): unknown }): void => {
      if (r.url().includes("/api/auth/logout")) {
        const hit = reqs.find((q) => q.url === r.url());
        if (hit) hit.status = r.status();
      }
    };
    page.on("response", onResp as (x: unknown) => void);

    const signedOut = await readJson<{ found: boolean; text: string; menuItems: string }>(page, `
      const want = ${JSON.stringify(WANT_LABELS)}.split("|").filter(Boolean);
      const items = Array.from(document.querySelectorAll("button, [role='menuitem'], a"));
      const el = items.find(b => want.includes((b.textContent || "").trim()));
      const menus = Array.from(document.querySelectorAll("[role='menu']")).map(m => m.textContent || "");
      if (!el) return { found: false, text: "", menuItems: menus.join(" || ") || "(no menu opened)" };
      el.click();
      return { found: true, text: (el.textContent || "").trim(), menuItems: menus.join(" || ") };
    `);
    if (!signedOut.found) {
      bad("a logout control exists",
        `navbar buttons found: ${opened || "(none)"}\n       menu state: ${signedOut.menuItems}`);
    } else {
      ok("a logout control exists", signedOut.text);
      await sleep(1500);
      page.off("request", onReq as (x: unknown) => void);
      page.off("response", onResp as (x: unknown) => void);
      const lo = reqs[reqs.length - 1];
      if (!lo) {
        bad("the browser sends a CSRF header with the logout request",
          "no /api/auth/logout request was observed at all");
      } else if (!lo.hasCsrf) {
        bad("the browser sends a CSRF header with the logout request",
          `the request went out with no X-CSRF-Token, so the server answered ${lo.status} and the session was never revoked`);
      } else if (lo.status >= 400) {
        bad("the browser sends a CSRF header with the logout request",
          `the request carried the header but the server answered ${lo.status}`);
      } else {
        ok(`the browser sends a CSRF header with the logout request (server answered ${lo.status})`);
      }
      for (let i = 0; i < 50; i++) {
        const at = await readJson<string>(page, "return location.pathname;").catch(() => "x");
        if (at.includes("/login")) break;
        await sleep(150);
      }
      const at = await readJson<string>(page, "return location.pathname;");
      if (at.includes("/login")) ok("logout returns the user to the login page", at);
      else bad("logout returns the user to the login page", `still on ${at}`);
      const after = await serverSeesSession();
      if (!after.live) ok(`the server revoked the session (${after.how})`);
      else bad("the server revoked the session",
        `the server still serves authenticated data after logout (${after.how}); the token was not invalidated server-side`);

      // Re-probe the login form NOW that we are actually back on /login. Doing it
      // while still authenticated found zero form controls, and the vacuity
      // guard caught that -- which is what the guard is for.
      await page.goto(`${origin}/en/login`, { waitUntil: "networkidle", timeout: 60_000 });
      const backOnLogin = await readJson<{ labels: number; unnamed: string[] }>(page, `
        const ctrls = Array.from(document.querySelectorAll("input:not([type=hidden]), select, textarea"));
        const unnamed = ctrls.filter(c => {
          const id = c.getAttribute("id");
          const lbl = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
          return !lbl && !c.getAttribute("aria-label") && !c.getAttribute("aria-labelledby");
        }).map(c => c.getAttribute("name") || c.tagName);
        return { labels: ctrls.length, unnamed };
      `);
      if (backOnLogin.labels < 2) {
        bad("the signed-out login form names every field",
          `only ${backOnLogin.labels} control(s) found after logout; the selector is probably wrong`);
      } else if (backOnLogin.unnamed.length === 0) {
        ok(`all ${backOnLogin.labels} signed-out login fields have an accessible name`);
      } else {
        bad("the signed-out login form names every field",
          `${backOnLogin.unnamed.length} unnamed: ${backOnLogin.unnamed.join(", ")}`);
      }

    // Direct evidence for the CSRF claim, independent of the UI: log in through
    // the API, then POST logout with NO X-CSRF-Token and see what the server does.
    // If it answers 200, the raw fetch in M1 really would have signed the user
    // out and my whole "logout was broken" reading is wrong.
    const rawLogout = await (async (): Promise<{ status: number; stillLive: boolean }> => {
      const jar: string[] = [];
      const c0 = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`);
      jar.push(...c0);
      const origin2 = origin;
      const login = await fetch(`${origin2}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: origin2 },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
      });
      const setCookies = login.headers.getSetCookie?.() ?? [];
      for (const sc of setCookies) jar.push(sc.split(";")[0]);
      const hdr = jar.join("; ");
      const out = await fetch(`${origin2}/api/auth/logout`, {
        method: "POST",
        headers: { origin: origin2, cookie: hdr },
      });
      return { status: out.status, stillLive: false };
    })();
    if (rawLogout.status === 403) ok("a raw logout with no CSRF header is refused with 403 (so the shipped bug was real)");
    else bad("a raw logout with no CSRF header is refused with 403",
      `the server answered ${rawLogout.status}; a header-less POST was accepted, so logout was never actually broken`);

    }
  } finally {
    await browser.close();
    await stopServer();
  }

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