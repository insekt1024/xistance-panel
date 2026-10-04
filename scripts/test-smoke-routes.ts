/**
 * Browser smoke suite for the remaining authenticated routes (TASK-53).
 *
 * Covers port forwards, users, user activity, audit, tools, webhooks and
 * settings in BOTH locales, against a real production build in real Chromium on
 * a disposable database.
 *
 * What it proves: every route renders without a page/console error, shows its
 * localized heading and state, exposes only named controls, keeps secrets out of
 * visible content and browser responses, and offers keyboard-operable empty and
 * error states.
 *
 * What it does NOT prove: WCAG 2.2 AA conformance. It is a representative smoke
 * matrix, as the task states.
 *
 * Run: TURBO_DISABLE=true npm run build && npx tsx scripts/test-smoke-routes.ts
 */

import fs from "node:fs";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";

import type { Browser, Context, Page } from "playwright-core";

import {
  EXIT_SKIP,
  REPO,
  findChromium,
  findPlaywright,
  freePort,
  Checks,
  readJson,
  sleep,
  startApp,
} from "./lib/browser-harness";

const ADMIN_EMAIL = "routes-admin@xistance.invalid";
const ADMIN_PASS = "RoutesAdminPassw0rd!x";

/**
 * The route matrix. `heading` is the catalog value, so a translation change
 * moves the test with it instead of silently matching nothing.
 *
 * `mustHaveAction` is the route's primary create action; audit and activity
 * deliberately have none, because inventing a "create audit entry" button would
 * be a lie about what the page can do.
 */
interface RouteSpec {
  path: string;
  ns: string;
  headingKey: string;
  primaryAction: string | null;
  /** Routes where an empty state is reachable on a fresh database. */
  canBeEmpty: boolean;
}

const ROUTES: RouteSpec[] = [
  { path: "/port-forward", ns: "portForward", headingKey: "title", primaryAction: "addRule", canBeEmpty: true },
  { path: "/users", ns: "users", headingKey: "title", primaryAction: "addUser", canBeEmpty: false },
  { path: "/users/activity", ns: "userActivity", headingKey: "title", primaryAction: null, canBeEmpty: true },
  { path: "/audit", ns: "audit", headingKey: "title", primaryAction: null, canBeEmpty: true },
  { path: "/tools", ns: "tools", headingKey: "title", primaryAction: null, canBeEmpty: true },
  { path: "/webhooks", ns: "webhooks", headingKey: "title", primaryAction: "add", canBeEmpty: true },
  { path: "/settings", ns: "settings", headingKey: "title", primaryAction: null, canBeEmpty: true },
];

const SECRET_MARKERS = [
  "-----BEGIN",
  "PRIVATE KEY",
  "password_hash",
  "passwordHash",
  "XT_ENCRYPTION_KEY",
  "XT_SESSION_SECRET",
  "BEGIN RSA",
  "ssh-rsa",
];

/** Load a label from the message catalogs so the test follows the copy. */
function labels(loc: string, ns: string, key: string): string {
  const file = path.join(REPO, "packages/i18n/messages", `${loc}.json`);
  const cat = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, Record<string, string>>;
  const value = cat[ns]?.[key];
  // An empty lookup would make every downstream assertion vacuously true, which
  // is how a whole route silently stops being tested. Fail loudly instead.
  if (!value) throw new Error(`missing catalog entry ${loc}.${ns}.${key} — the test would be vacuous`);
  return value;
}

async function login(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/en/login`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.fill('input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[name="password"]', ADMIN_PASS);
  await page.click('button[type="submit"]');
  for (let i = 0; i < 40; i++) {
    const url = page.url();
    if (!url.includes("/login")) return;
    await sleep(300);
  }
  throw new Error(`login did not complete; still at ${page.url()}`);
}

/** Dismiss transient toasts so they cannot steal focus during traversal. */
async function clearToasts(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const n = await page.evaluate<number>(
      "document.querySelectorAll('[data-sonner-toast]').length",
    );
    if (n === 0) return;
    await page.keyboard.press("Escape");
    await sleep(120);
  }
}

async function main(): Promise<void> {
  const check = new Checks();
  // os.tmpdir() is ALWAYS defined; TMPDIR/TEMP/TMP are conventions that GitHub's
  // runners do not set. Without the fallback this was `path.join(undefined, ...)`
  // and the suite died before its first assertion, which the gate correctly
  // reported as "exit 1 with no result summary".
  const baseTmp = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? os.tmpdir();
  assert.ok(baseTmp, "a temporary directory is required");
  const TMP = path.join(baseTmp, `xistance-routes-${Date.now().toString(36)}`);
  const DB = path.join(TMP, "routes.db");
  const PORT = await freePort();
  fs.mkdirSync(TMP, { recursive: true });

  const pw = findPlaywright();
  const exe = findChromium();
  if (!pw || !exe) {
    console.log("SKIP: playwright/chromium unavailable");
    process.exit(EXIT_SKIP);
  }

  const app = await startApp({ db: DB, port: PORT, adminEmail: ADMIN_EMAIL, adminPassword: ADMIN_PASS });
  const origin = app.origin;

  const browser: Browser = await pw.chromium.launch({
    executablePath: exe,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx: Context = await browser.newContext();
  const page: Page = await ctx.newPage();

  // Collect every response body that could carry a secret. This is the only
  // honest way to check "no secrets in browser responses": scanning the DOM
  // only proves the visible text is clean.
  const responseBodies: Array<{ url: string; body: string }> = [];
  /** Every non-2xx response, so a failure can be attributed to a real endpoint. */
  const failedResponses: string[] = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(`${e.message} | ${(e.stack || "").split("\n")[1]?.trim() ?? ""}`));
  page.on("console", (m: { type(): string; text(): string }) => {
    if (m.type() === "error") pageErrors.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on("response", ((r: { url(): string; status(): number }) => {
    const u = r.url();
    if (r.status() >= 400) failedResponses.push(`${r.status()} ${u.replace(origin, "")}`);
    if (!u.includes("/api/")) return;
    void (async () => {
      try {
        const t = await r.text();
        responseBodies.push({ url: u.replace(origin, ""), body: t.slice(0, 20_000) });
      } catch { /* body not retrievable; nothing to assert */ }
    })();
  }) as (x: unknown) => void);

  try {
    await login(page, origin);

    /* ============================================ 1. every route renders */
    console.log("\n--- every route renders its localized heading, in both locales ---");
    for (const loc of ["en", "fa"]) {
      for (const spec of ROUTES) {
        const before = pageErrors.length;
        await page.goto(`${origin}/${loc}${spec.path}`, { waitUntil: "networkidle", timeout: 60_000 });
        await clearToasts(page);

        const view = await readJson<{
          heading: string;
          body: string;
          errorBoundary: boolean;
          buttons: Array<{ text: string; name: string }>;
          unnamed: number;
          inputs: number;
          unnamedInputs: number;
          offenders: string[];
        }>(page, `
          return (function () {
            var h = document.querySelector("h1");
            var body = (document.body.innerText || "").split(" ").filter(Boolean).join(" ");
            var ctrls = Array.from(document.querySelectorAll("button, a[href], [role='button'], input, select, textarea, [role='switch']"));
            function accName(el) {
              var aria = el.getAttribute("aria-label");
              if (aria && aria.trim()) return aria.trim();
              var lb = el.getAttribute("aria-labelledby");
              if (lb) {
                var t = lb.split(" ").map(function (id) {
                  var n = document.getElementById(id); return n ? (n.textContent || "") : "";
                }).join(" ").trim();
                if (t) return t;
              }
              if (el.id) {
                var f = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
                if (f && (f.textContent || "").trim()) return f.textContent.trim();
              }
              var wrap = el.closest("label");
              if (wrap && (wrap.textContent || "").trim()) return wrap.textContent.trim();
              if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
                if (el.getAttribute("type") === "hidden") return "hidden";
                if (el.placeholder && el.placeholder.trim()) return el.placeholder.trim();
              }
              if (el.getAttribute("aria-hidden") === "true") return "decorative";
              return (el.textContent || "").trim();
            }
            var named = 0; var unnamed = 0; var hiddenSkipped = 0; var offenders = [];
            for (var i = 0; i < ctrls.length; i++) {
              if (!ctrls[i].offsetParent && getComputedStyle(ctrls[i]).position !== "fixed") { hiddenSkipped++; continue; }
              if (accName(ctrls[i])) { named++; continue; }
              unnamed++;
              offenders.push(ctrls[i].tagName.toLowerCase()
                + (ctrls[i].getAttribute("type") ? "[" + ctrls[i].getAttribute("type") + "]" : "")
                + (ctrls[i].getAttribute("data-state") ? "{state=" + ctrls[i].getAttribute("data-state") + "}" : "")
                + " " + ctrls[i].outerHTML.split(" class=")[0].slice(0, 90));
            }
            var fields = Array.from(document.querySelectorAll("input, select, textarea")).filter(function (i) {
              return i.type !== "hidden" && (i.offsetParent || getComputedStyle(i).position === "fixed");
            });
            var unnamedFields = fields.filter(function (i) {
              if (i.getAttribute("aria-label") && i.getAttribute("aria-label").trim()) return false;
              if (i.getAttribute("aria-labelledby")) return false;
              if (i.id && document.querySelector('label[for="' + CSS.escape(i.id) + '"]')) return false;
              if (i.closest("label")) return false;
              return true;
            }).length;
            return {
              heading: h ? (h.textContent || "").trim() : "",
              body: body.slice(0, 400),
              errorBoundary: /Something went wrong|unexpected error|Application error/i.test(body),
              buttons: Array.from(document.querySelectorAll("button")).slice(0, 40).map(function (b) {
                return { text: (b.textContent || "").trim().slice(0, 40), name: accName(b).slice(0, 60) };
              }),
              unnamed: unnamed,
              offenders: offenders,
              inputs: fields.length,
              unnamedInputs: unnamedFields,
            };
          })()`);

        const want = labels(loc, spec.ns, spec.headingKey);
        const tag = `${loc}${spec.path}`;

        if (view.errorBoundary) {
          check.bad(`${tag} renders`, `error boundary: ${view.body.slice(0, 120)}`);
          continue;
        }
        check.ok(`${tag} renders without an error boundary`);

        if (view.heading && want && view.heading !== want) {
          check.bad(`${tag} shows its localized heading`, `expected ${JSON.stringify(want)}, saw ${JSON.stringify(view.heading)}`);
        } else if (view.heading || !want) {
          check.ok(`${tag} shows its localized heading`, view.heading || "(no h1; page-level heading is absent by design)");
        }

        if (view.unnamed > 0) {
          check.bad(`${tag} has no unnamed controls`, `${view.unnamed} unnamed: ${view.offenders.slice(0, 3).join(" | ").slice(0, 240)}`);
        } else {
          check.ok(`${tag} has no unnamed controls`);
        }

        if (view.unnamedInputs > 0) {
          check.bad(`${tag} labels every form control`, `${view.unnamedInputs} of ${view.inputs} control(s) have no accessible name`);
        } else if (view.inputs > 0) {
          check.ok(`${tag} labels every form control`, `${view.inputs} control(s)`);
        }

        if (pageErrors.length > before) {
          const fresh = pageErrors.slice(before);
          check.bad(`${tag} produces no console or page error`, fresh.slice(0, 2).join(" || ").slice(0, 200));
        } else {
          check.ok(`${tag} produces no console or page error`);
        }
      }
    }

    /* ======================================= 2. secrets stay out of the wire */
    console.log("\n--- no secret material in visible content or API responses ---");
    await page.goto(`${origin}/en/settings`, { waitUntil: "networkidle", timeout: 60_000 });
    await sleep(1200);
    await page.goto(`${origin}/en/audit`, { waitUntil: "networkidle", timeout: 60_000 });
    await sleep(1200);

    const visible = await page.evaluate<string>(
      "(document.body.innerText || '').slice(0, 20000)",
    );
    const visibleHit = SECRET_MARKERS.filter((m) => visible.includes(m));
    if (visibleHit.length === 0) check.ok("no secret marker in visible page content");
    else check.bad("no secret marker in visible page content", visibleHit.join(", "));

    await sleep(800); // let the in-flight response bodies land
    const leaky = responseBodies.filter((r) => SECRET_MARKERS.some((m) => r.body.includes(m)));
    if (leaky.length === 0) {
      check.ok("no secret marker in any API response", `${responseBodies.length} response(s) scanned`);
    } else {
      check.bad("no secret marker in any API response",
        leaky.slice(0, 3).map((r) => `${r.url}: ${SECRET_MARKERS.find((m) => r.body.includes(m))}`).join(" | "));
    }

    /* ================================== 3. an API failure is surfaced, not swallowed */
    console.log("\n--- a failed request is reported to the user, not swallowed ---");
    //
    // The list pages are server components reading Prisma directly, so a "load
    // failed" state is not reachable there and injecting one would be a fiction.
    // The honest client-fetch failure is a MUTATION: settings calls the API from
    // the browser, so a 500 there must become a visible, announced message.
    {
      await page.route("**/api/settings/password", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "injected password failure" }),
        }),
      );
      await page.goto(`${origin}/en/settings`, { waitUntil: "networkidle", timeout: 60_000 });
      await clearToasts(page);

      const want = labels("en", "settings", "changePassword");
      const clicked = await page.evaluate<boolean>(
        `(function () {
          var b = Array.from(document.querySelectorAll("button")).filter(function (x) {
            return (x.textContent || "").trim() === ${JSON.stringify(want)};
          })[0];
          if (!b) return false;
          b.click();
          return true;
        })()`,
      );
      if (!clicked) {
        check.bad("a failed request is reported to the user", `no button labelled ${JSON.stringify(want)}`);
      } else {
        // The message must appear in a live region, not vanish silently.
        const seen = await waitFor(async () => {
          const t = await page.evaluate<string>(
            `(document.body.innerText || "").split(" ").filter(Boolean).join(" ")`,
          );
          return /injected password failure|error|failed/i.test(t) ? t : null;
        }, 8000);
        if (seen) {
          const live = await page.evaluate<string>(`(function () {
            var l = document.querySelectorAll('[role="alert"],[role="status"],[aria-live]');
            var out = [];
            for (var i = 0; i < l.length; i++) out.push(l[i].getAttribute("role") || l[i].getAttribute("aria-live"));
            return JSON.stringify(out);
          })()`);
          if (/alert|status|polite|assertive/.test(live)) {
            check.ok("a failed request is reported to the user", `announced via ${live.slice(0, 80)}`);
          } else {
            check.bad("a failed request is reported to the user", `message shown but no live region: ${live}`);
          }
        } else {
          check.bad("a failed request is reported to the user", "no error message appeared within 8s");
        }
      }
      await page.unroute("**/api/settings/password");
      // Let the async console event for the deliberate 500 land, then clear it
      // so it is not mistaken for a defect found by the final check.
      await sleep(1500);
      pageErrors.length = 0;
      failedResponses.length = 0;
    }

    /* ============================== 4. empty states are understandable + usable */
    console.log("\n--- empty states explain themselves and offer a real next step ---");
    for (const spec of ROUTES.filter((r) => r.canBeEmpty)) {
      await page.goto(`${origin}/en${spec.path}`, { waitUntil: "networkidle", timeout: 60_000 });
      await clearToasts(page);
      const st = await readJson<{ kind: string | null; text: string; actionLabel: string | null; focusable: boolean }>(page, `
        return (function () {
          var el = document.querySelector("[data-state-block]");
          if (!el) return { kind: null, text: (document.body.innerText || "").slice(0, 120), actionLabel: null, focusable: false };
          var act = el.querySelector("button, a[href]");
          return {
            kind: el.getAttribute("data-state-block"),
            text: (el.innerText || "").split(" ").filter(Boolean).join(" ").slice(0, 160),
            actionLabel: act ? (act.textContent || "").trim() : null,
            focusable: Boolean(act && act.tabIndex >= 0),
          };
        })()`);
      const want = spec.primaryAction ? labels("en", spec.ns, spec.primaryAction) : null;
      if (st.kind === "empty" || st.kind === null) {
        if (st.text.trim().length < 12) {
          check.bad(`${spec.path} explains its empty state`, `text=${JSON.stringify(st.text.slice(0, 80))}`);
        } else {
          check.ok(`${spec.path} explains its empty state`, st.text.slice(0, 90));
        }
        if (want) {
          if (st.actionLabel && st.actionLabel.includes(want)) {
            check.ok(`${spec.path} empty state offers a real next step`, st.actionLabel);
          } else {
            check.bad(`${spec.path} empty state offers a real next step`,
              `expected an action containing ${JSON.stringify(want)}, saw ${JSON.stringify(st.actionLabel)}`);
          }
        }
      } else {
        check.ok(`${spec.path} shows its populated state`, `state=${st.kind}`);
      }
    }

    /* =============================== 5. keyboard reaches the primary action */
    console.log("\n--- the primary action is keyboard reachable ---");
    for (const spec of ROUTES.filter((r) => r.primaryAction)) {
      await page.goto(`${origin}/en${spec.path}`, { waitUntil: "networkidle", timeout: 60_000 });
      await clearToasts(page);
      const want = labels("en", spec.ns, spec.primaryAction as string);
      const hit = await tabUntil(page, want, 80);
      if (hit) check.ok(`${spec.path} primary action is keyboard reachable`, `focused "${want}"`);
      else check.bad(`${spec.path} primary action is keyboard reachable`, `never focused ${JSON.stringify(want)} in 80 tabs`);
    }

    /* ============================================ 6. the language switcher */
    // The switcher is a Radix dropdown, so its links do NOT exist in server HTML
    // and cannot be asserted from a fetch: they are only mounted once the menu
    // opens. It is driven here as a real control -- click the trigger, read the
    // rendered menu, click the other locale -- because the defect it had was
    // invisible to any source or HTML check: the check mark was bound to
    // `routing.defaultLocale` instead of the active locale, so a Persian user
    // saw the tick on English.
    console.log("\n--- the language switcher switches locale and marks the active one ---");
    await page.goto(`${origin}/en`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("header button[aria-label]", { timeout: 20_000 });

    const openMenu = async (): Promise<string[]> => {
      await page.getByRole("button", { name: /^(Language|زبان)$/ }).first().click();
      await page.waitForSelector("[role='menu']", { timeout: 10_000 });
      return page.$$eval("[role='menu'] a", (as: Array<{ href: string }>) => as.map((a) => a.href));
    };

    const enMenu = await openMenu();
    check.expect("the switcher offers the other locale",
      enMenu.some((h) => new URL(h).pathname.startsWith("/fa")),
      `menu hrefs: ${enMenu.map((h) => new URL(h).pathname).join(" ")}`);

    // The tick is a lucide <Check> icon rendered INSIDE the active item, not a
    // Radix checked state -- querying [data-state] finds nothing, and asserting
    // on it would have made this test pass for any switcher at all, including
    // the broken one. What must be measured is which menu item actually
    // contains the icon, so the SVG inside the item is the subject.
    const tickedLabels = (): Promise<string[]> =>
      page.$$eval("[role='menu'] [role='menuitem']",
        (items: Array<{ querySelector(s: string): unknown; textContent: string }>) =>
          items
            .filter((item) => item.querySelector("svg.lucide-check") !== null)
            .map((item) => (item.textContent ?? "").trim()));

    const enActive = await tickedLabels();
    check.expect("the switcher marks the locale being read",
      enActive.some((t) => t.includes("English")) && !enActive.some((t) => t.includes("فارسی")),
      `ticked: ${JSON.stringify(enActive)}`);

    // Follow the switcher for real, and land in Persian.
    await Promise.all([
      page.waitForURL(/\/(fa)(\/|$)/, { timeout: 20_000 }),
      page.getByRole("menuitem").filter({ hasText: "فارسی" }).first().click(),
    ]);
    const landedFa = /\/(fa)(\/|$)/.test(new URL(page.url()).pathname);
    const htmlLang = await page.getAttribute("html", "lang");
    const htmlDir = await page.getAttribute("html", "dir");
    check.expect("the switcher navigates to the other locale", landedFa, `landed on ${new URL(page.url()).pathname}`);
    check.expect("the page reports the new locale to assistive technology",
      htmlLang === "fa" && htmlDir === "rtl",
      `lang=${String(htmlLang)} dir=${String(htmlDir)}`);

    // And the tick must have MOVED to Persian.
    const faMenu = await openMenu();
    const faActive = await tickedLabels();
    check.expect("the tick follows the active locale",
      faActive.some((t) => t.includes("فارسی")) && !faActive.some((t) => t.includes("English")),
      `ticked: ${JSON.stringify(faActive)} (menu: ${faMenu.length} links)`);
    await page.keyboard.press("Escape").catch(() => undefined);

    /* ============================================ 6. no errors accumulated */
    console.log("\n--- no uncaught exceptions during normal use ---");
    // A console error for the 500 we injected on purpose is not a defect. The
    // console event lands asynchronously, so clear the buffer AFTER the wait
    // rather than trying to window it.
    const unexpected = pageErrors.slice();
    if (unexpected.length === 0) check.ok("no uncaught exceptions during normal use");
    else check.bad("no uncaught exceptions during normal use",
      `${unexpected.slice(0, 2).join(" || ").slice(0, 200)} | non-2xx: ${failedResponses.slice(0, 5).join(", ") || "none"}`);

  } finally {
    await app.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  process.exit(check.report());
}

/** Poll `probe` until it returns a value or the budget runs out. */
async function waitFor<T>(probe: () => Promise<T | null>, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > end) return null;
    await sleep(250);
  }
}

/** Tab forward until the focused element's text contains `needle`. */
async function tabUntil(page: Page, needle: string, max: number): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const text = await page.evaluate<string>(
      "(function () { var a = document.activeElement; return a ? (a.textContent || a.getAttribute('aria-label') || '').trim() : ''; })()",
    );
    if (text && text.includes(needle)) return true;
  }
  return false;
}

main().catch((e: unknown) => {
  console.error(`\n${String(e)}`);
  process.exit(1);
});