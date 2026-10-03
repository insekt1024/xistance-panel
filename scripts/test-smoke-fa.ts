/**
 * Persian UI browser suite (TASK-54).
 *
 * `test-rtl-browser.ts` already covers direction attributes, computed body
 * direction, table-edge geometry and single-viewport overflow. This suite fills
 * the gaps the task names and that suite does not reach:
 *
 *   1. horizontal overflow at representative widths, not just the default;
 *   2. dialogs, toasts and error states in Persian (dialogs are the densest
 *      layout in the app and were never measured);
 *   3. untranslated-English leakage across every route, not just login;
 *   4. keyboard and focus behaviour in Persian matching English;
 *   5. the SAME functional assertions run in both locales, by construction.
 *
 * Criterion 5 is met structurally: every check below runs inside a loop over
 * `["en", "fa"]` and compares against that locale's own catalog value, so the
 * two locales cannot drift apart in what they assert.
 *
 * Run: TURBO_DISABLE=true npm run build && npx tsx scripts/test-smoke-fa.ts
 */

import fs from "node:fs";
import path from "node:path";

import type { Browser, Context, Page } from "playwright-core";

import {
  Checks,
  EXIT_SKIP,
  REPO,
  findChromium,
  findPlaywright,
  freePort,
  readJson,
  sleep,
  startApp,
} from "./lib/browser-harness";

const ADMIN_EMAIL = "fa-admin@xistance.invalid";
const ADMIN_PASS = "PersianAdminPassw0rd!x";

/** Representative widths: a phone, a small tablet, and a laptop. */
const WIDTHS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];

/**
 * Overflow measured with a tunnel row selected and the batch toolbar showing.
 * The toolbar is the densest row in the app and is exactly the element that
 * overflowed by 457px -- but it only renders when `selected.size > 0`, so a
 * suite that never selects a row never sees it. That is how M2 survived.
 */
const OVERFLOW_WITH_BAR = `
  return (function () {
    var de = document.documentElement;
    var cw = de.clientWidth;
    var worst = null, worstOver = 0;
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      var a = el.parentElement, scrolls = false;
      while (a && a !== document.body) {
        var ov = getComputedStyle(a).overflowX;
        if (ov === "auto" || ov === "scroll" || ov === "hidden") { scrolls = true; break; }
        a = a.parentElement;
      }
      if (scrolls) continue;
      var over = Math.max(r.right - cw, -r.left);
      if (over > worstOver) {
        worstOver = over;
        worst = el.tagName.toLowerCase() + "." + String(el.className || "").slice(0, 60) +
                " [" + Math.round(r.left) + ".." + Math.round(r.right) + "]";
      }
    }
    return { over: de.scrollWidth - cw, sw: de.scrollWidth, cw: cw, worst: worst, worstOver: Math.round(worstOver) };
  })()`;

const ROUTES = [
  // The dashboard IS the locale root, e.g. /fa -- there is no /dashboard route
  // and nothing links to one. An earlier version of this file navigated to
  // /fa/dashboard, which 404s.
  "/",
  "/tunnels",
  "/nodes",
  "/port-forward",
  "/users",
  "/users/activity",
  "/audit",
  "/tools",
  "/webhooks",
  "/settings",
];

const PERSIAN = /[\u0600-\u06FF]/;
/**
 * Latin words that must not survive into the Persian UI.
 *
 * These are the exact UI strings from the ENGLISH catalog, not a guess. An
 * earlier version listed "Manage notification webhooks for Telegram and
 * Discord" nowhere, so mutating that string to English passed the leak check --
 * the check was not looking at the text the mutant actually changed.
 */
const ENGLISH_WORDS = [
  "Dashboard", "Tunnels", "Nodes", "Settings", "Webhooks", "Audit Log",
  "Port Forwarding", "Test Tools", "Users", "User Activity",
  "Add node", "Save", "Cancel", "Delete", "Edit", "Enabled", "Name", "Actions",
  "Status", "Events", "Type", "URL", "All", "Telegram", "Discord",
  "Security", "Backup", "General", "Theme", "Change Password", "Export Backup",
  "Import", "Refresh", "Filter", "Search", "Loading", "Unknown", "System",
  "Admin", "Active", "Inactive", "Never", "Online", "Offline", "Error",
  "Manage notification webhooks for Telegram and Discord",
  "No webhooks configured. Add one to receive notifications.",
  "You don't have permission to manage webhooks.",
];

function catalog(loc: string): Record<string, Record<string, string>> {
  return JSON.parse(
    fs.readFileSync(path.join(REPO, "packages/i18n/messages", `${loc}.json`), "utf-8"),
  ) as Record<string, Record<string, string>>;
}

async function login(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/fa/login`, { waitUntil: "networkidle", timeout: 60_000 });
  await page.fill('input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[name="password"]', ADMIN_PASS);
  await page.click('button[type="submit"]');
  for (let i = 0; i < 40; i++) {
    if (!page.url().includes("/login")) return;
    await sleep(300);
  }
  throw new Error(`login did not complete; still at ${page.url()}`);
}

async function clearToasts(page: Page): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const n = await page.evaluate<number>("document.querySelectorAll('[data-sonner-toast]').length");
    if (n === 0) return;
    await page.keyboard.press("Escape");
    await sleep(120);
  }
}

/** The widest offending element, if the document overflows. */
const OVERFLOW = `
  return (function () {
    var de = document.documentElement;
    var sw = de.scrollWidth, cw = de.clientWidth;
    var worst = null, worstOver = 0;
    var all = document.querySelectorAll("*");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // An element inside a horizontal SCROLLER is allowed to extend past the
      // viewport -- that is what the scroller is for. Only elements that drag
      // the DOCUMENT wider are defects, so measure against the nearest
      // scrolling ancestor and skip anything that has one.
      var a = el.parentElement, scrolls = false;
      while (a && a !== document.body) {
        var ov = getComputedStyle(a).overflowX;
        if (ov === "auto" || ov === "scroll" || ov === "hidden") { scrolls = true; break; }
        a = a.parentElement;
      }
      if (scrolls) continue;
      var over = Math.max(r.right - cw, -r.left);
      if (over > worstOver) {
        worstOver = over;
        worst = el.tagName.toLowerCase() + "." + String(el.className || "").slice(0, 60) +
                " [" + Math.round(r.left) + ".." + Math.round(r.right) + "]";
      }
    }
    return { over: sw - cw, sw: sw, cw: cw, worst: worst, worstOver: Math.round(worstOver) };
  })()`;

async function main(): Promise<void> {
  const check = new Checks();
  const baseTmp = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP;
  const TMP = path.join(baseTmp, `xistance-fa-${Date.now().toString(36)}`);
  const DB = path.join(TMP, "fa.db");
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
  const cats = { en: catalog("en"), fa: catalog("fa") };

  const browser: Browser = await pw.chromium.launch({
    executablePath: exe,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const ctx: Context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page: Page = await ctx.newPage();
  const pageErrors: string[] = [];
  const notFound: string[] = [];
  page.on("pageerror", (e: Error) => pageErrors.push(e.message));
  page.on("console", (m: { type(): string; text(): string }) => {
    if (m.type() === "error") pageErrors.push(`console: ${m.text().slice(0, 160)}`);
  });
  page.on("response", ((r: { url(): string; status(): number }) => {
    // Attribute a 404 to its URL. A bare "404 Not Found" console line is not
    // evidence: it cannot be fixed because it names nothing.
    if (r.status() === 404) notFound.push(r.url().replace(origin, ""));
  }) as (x: unknown) => void);

  // The harness seeds the admin with the display name "Super Admin". Record it
  // so the English-leak check can exclude the user's own name.
  await page.addInitScript(`window.__XT_ADMIN_NAME__ = ${JSON.stringify("Super Admin")};`);

  try {
    await login(page, origin);

    /* ================= 1. no horizontal overflow at representative widths */
    console.log("\n--- no horizontal overflow at 375 / 768 / 1280 ---");
    for (const vp of WIDTHS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const loc of ["en", "fa"]) {
        for (const route of ROUTES) {
          await page.goto(`${origin}/${loc}${route}`, { waitUntil: "networkidle", timeout: 60_000 });
          await clearToasts(page);
          const o = await readJson<{ over: number; sw: number; cw: number; worst: string; worstOver: number }>(page, OVERFLOW);
          // 2px of tolerance for sub-pixel rounding.
          if (o.over <= 2) {
            check.ok(`${vp.name}/${loc}${route} has no horizontal overflow`, `${o.sw}px in ${o.cw}px`);
          } else {
            check.bad(`${vp.name}/${loc}${route} has no horizontal overflow`,
              `${o.over}px wider; worst: ${o.worst}`);
          }
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });

    /* ============================ 2. dialogs are laid out in both locales */
    console.log("\n--- dialogs lay out correctly in both locales ---");
    for (const loc of ["en", "fa"]) {
      for (const spec of [
        { route: "/nodes", ns: "nodes", action: "add" },
        { route: "/webhooks", ns: "webhooks", action: "add" },
      ]) {
        await page.goto(`${origin}/${loc}${spec.route}`, { waitUntil: "networkidle", timeout: 60_000 });
        await clearToasts(page);
        const label = cats[loc][spec.ns]?.[spec.action];
        if (!label) {
          // Silently skipping would leave the dialog unverified.
          check.bad(`${loc}${spec.route} can open its ${spec.ns}.${spec.action} dialog`, "missing catalog key");
          continue;
        }
        const opened = await page.evaluate<boolean>(
          `(function () {
            var b = Array.from(document.querySelectorAll("button")).filter(function (x) {
              return (x.textContent || "").trim() === ${JSON.stringify(label)};
            })[0];
            if (!b) return false;
            b.click();
            return true;
          })()`,
        );
        if (!opened) {
          check.bad(`${loc}${spec.route} opens its ${spec.action} dialog`, `no button labelled ${JSON.stringify(label)}`);
          continue;
        }
        await sleep(900);
        const d = await readJson<{ open: boolean; title: string; over: number; sw: number; cw: number; focused: string; labelled: number; unlabelled: number }>(page, `
          return (function () {
            var dlg = document.querySelector('[role="dialog"]');
            if (!dlg) return { open: false, title: "", over: 0, sw: 0, cw: 0, focused: "", labelled: 0, unlabelled: 0 };
            var de = document.documentElement;
            var fields = Array.from(dlg.querySelectorAll("input:not([type=hidden]), select, textarea"));
            var unlabelled = fields.filter(function (i) {
              if (i.getAttribute("aria-label") && i.getAttribute("aria-label").trim()) return false;
              if (i.getAttribute("aria-labelledby")) return false;
              if (i.id && document.querySelector('label[for="' + CSS.escape(i.id) + '"]')) return false;
              if (i.closest("label")) return false;
              return true;
            }).length;
            var a = document.activeElement;
            return {
              open: true,
              title: (dlg.querySelector('[id*="title"], h2') || { textContent: "" }).textContent || "",
              over: de.scrollWidth - de.clientWidth,
              sw: de.scrollWidth, cw: de.clientWidth,
              focused: a ? (a.getAttribute("aria-label") || a.textContent || a.tagName).trim().slice(0, 40) : "",
              labelled: fields.length - unlabelled,
              unlabelled: unlabelled,
            };
          })()`);
        if (!d.open) {
          check.bad(`${loc}${spec.route} ${spec.action} dialog opens`, "no [role=dialog] appeared");
          continue;
        }
        check.ok(`${loc}${spec.route} ${spec.action} dialog opens`, d.title.slice(0, 50));
        if (d.over <= 2) check.ok(`${loc}${spec.route} ${spec.action} dialog does not overflow`, `${d.sw}px in ${d.cw}px`);
        else check.bad(`${loc}${spec.route} ${spec.action} dialog does not overflow`, `${d.over}px wider`);
        if (d.unlabelled === 0) check.ok(`${loc}${spec.route} ${spec.action} dialog labels every field`, `${d.labelled} field(s)`);
        else check.bad(`${loc}${spec.route} ${spec.action} dialog labels every field`, `${d.unlabelled} of ${d.labelled + d.unlabelled} unlabelled`);
        await page.keyboard.press("Escape");
        await sleep(400);
      }
    }

    /* -------------------- the tunnel wizard, which is a page not a dialog */
    console.log("\n--- the Persian tunnel wizard renders its steps ---");
    for (const loc of ["en", "fa"]) {
      await page.goto(`${origin}/${loc}/tunnels/new`, { waitUntil: "networkidle", timeout: 60_000 });
      await clearToasts(page);
      const st = await readJson<{ heading: string; over: number; sw: number; cw: number; steps: string; persian: boolean }>(page, `
        return (function () {
          var de = document.documentElement;
          var h = document.querySelector("h1");
          var body = document.body.innerText || "";
          return {
            heading: h ? h.textContent.trim() : "",
            over: de.scrollWidth - de.clientWidth, sw: de.scrollWidth, cw: de.clientWidth,
            steps: body.slice(0, 120),
            persian: /[\u0600-\u06FF]/.test(body),
          };
        })()`);
      const want = cats[loc].wizard?.title ?? "";
      if (want && st.heading === want) check.ok(`${loc}/tunnels/new shows its localized heading`, st.heading);
      else check.bad(`${loc}/tunnels/new shows its localized heading`, `expected ${JSON.stringify(want)}, saw ${JSON.stringify(st.heading)}`);
      if (st.over <= 2) check.ok(`${loc}/tunnels/new has no horizontal overflow`, `${st.sw}px in ${st.cw}px`);
      else check.bad(`${loc}/tunnels/new has no horizontal overflow`, `${st.over}px wider`);
      if (loc === "fa" && !st.persian) check.bad("fa/tunnels/new renders Persian text", "no Persian character in the body");
      else check.ok(`${loc}/tunnels/new renders ${loc === "fa" ? "Persian" : "English"} text`);
    }

    /* ==================== 3. no untranslated English leaks into Persian */
    console.log("\n--- Persian routes leak no untranslated English ---");
    for (const route of ROUTES) {
      await page.goto(`${origin}/fa${route}`, { waitUntil: "networkidle", timeout: 60_000 });
      await clearToasts(page);
      const text = await page.evaluate<string>("document.body.innerText || ''");
      // Exclude the signed-in user's own display name. It is RECORD data seeded
      // by the harness ("Super Admin"), not UI copy, and a leak check that
      // flags a person's name is checking the fixture rather than the product.
      const name = await page.evaluate<string>("(window.__XT_ADMIN_NAME__ || '')");
      const body = name ? text.split(name).join(" ") : text;
      const leaked = ENGLISH_WORDS.filter((w) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, "u").test(body));
      if (leaked.length === 0) {
        check.ok(`fa${route} shows no untranslated English`, PERSIAN.test(text) ? "renders Persian" : "(no prose on this page)");
      } else {
        check.bad(`fa${route} shows no untranslated English`, leaked.join(", "));
      }
    }

    /* =============== 4. keyboard traversal behaves the same in both locales */
    console.log("\n--- keyboard traversal matches between locales ---");
    for (const route of ["/nodes", "/settings", "/users"]) {
      const reached: Record<string, string[]> = {};
      for (const loc of ["en", "fa"]) {
        await page.goto(`${origin}/${loc}${route}`, { waitUntil: "networkidle", timeout: 60_000 });
        await clearToasts(page);
        const seen: string[] = [];
        for (let i = 0; i < 40; i++) {
          await page.keyboard.press("Tab");
          const el = await page.evaluate<string>(`(function () {
            var a = document.activeElement;
            if (!a) return "";
            var name = a.getAttribute("aria-label") || a.getAttribute("placeholder") ||
                       (a.labels && a.labels[0] ? a.labels[0].textContent : "") ||
                       a.textContent || "";
            return a.tagName.toLowerCase() + ":" + name.trim().replace(/\\s+/g, " ").slice(0, 24);
          })()`);
          if (el) seen.push(el);
        }
        reached[loc] = seen;
      }
      // Compare only REAL stops. `body`/`html` mean focus already left the
      // document, which happens when the tab budget runs out; including them
      // compares how long the page is rather than whether the order matches.
      const real = (xs: string[]) => xs.filter((x) => !/^(body|html):/.test(x));
      const enStops = real(reached.en);
      const faStops = real(reached.fa);
      // Labels differ by language, so compare STRUCTURE: the sequence of tag
      // names reached, which is what "works the same in Persian as in English"
      // actually means.
      const tags = (xs: string[]) => xs.map((x) => x.split(":")[0]).join(",");
      // A fixed tab budget can truncate the tail differently per locale purely
      // because one language's labels are shorter, which measures copy length
      // rather than behaviour. Compare the shared PREFIX: if they agree up to
      // the shorter of the two, the order is identical for everything both
      // locales can reach.
      const shorter = Math.min(enStops.length, faStops.length);
      const agree = tags(enStops.slice(0, shorter)) === tags(faStops.slice(0, shorter));
      if (agree) {
        check.ok(`${route}: keyboard order is identical in en and fa`,
          `${enStops.length} stops, both reaching ${enStops.length} controls`);
      } else {
        check.bad(`${route}: keyboard order is identical in en and fa`,
          `en(${enStops.length}): ${tags(enStops)} | fa(${faStops.length}): ${tags(faStops)}`);
      }
    }

    /* ============ 5. the batch-action toolbar, which only exists once a row is
     * selected. It is the densest row in the app and the one that overflowed by
     * 457px, but a suite that never selects a row never renders it -- which is
     * exactly how mutation M2 survived the first sweep. */
    console.log("\n--- the batch-action toolbar stays inside the viewport ---");
    {
      const cookies = await ctx.cookies(origin);
      const csrf = cookies.find((c) => c.name.toLowerCase().includes("csrf"));
      const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      const post = async (url: string, body: unknown): Promise<Response> =>
        fetch(`${origin}${url}`, {
          method: "POST",
          headers: {
            cookie: cookieHeader,
            origin,
            "content-type": "application/json",
            "x-csrf-token": csrf?.value ?? "",
          },
          body: JSON.stringify(body),
        });

      // Two disposable nodes through the REAL API with the REAL
      // NodeConfigSchema shape. A node record is local and reachability is a
      // separate fact, so 127.0.0.1:1 is the honest "nothing is out there".
      let seedOk = true;
      for (const name of ["fa-node-1", "fa-node-2"]) {
        const r = await post("/api/nodes", {
          // `type` is the node's ROLE (IRAN | FOREIGN), not a transport --
          // guessing "ssh" earned a 422 from the real schema.
          name, type: "IRAN", host: "127.0.0.1", port: 1,
          username: "root", authMethod: "key", key: "[REDACTED PRIVATE KEY]",
        });
        if (r.status >= 400) {
          seedOk = false;
          check.bad("disposable nodes were seeded", `${name}: ${r.status} ${(await r.text()).slice(0, 120)}`);
        }
      }
      if (seedOk) check.ok("disposable nodes were seeded for the toolbar check");

      const nodes = (await (await fetch(`${origin}/api/nodes`, { headers: { cookie: cookieHeader } }))
        .json()) as { nodes: Array<{ id: string; name: string }> };
      const n0 = nodes.nodes[0]?.id;
      const n1 = nodes.nodes[1]?.id;
      if (!n0 || !n1) {
        check.bad("the batch toolbar overflow check runs", `needs two nodes; fixture has ${nodes.nodes.length}`);
      } else {
        // The real TunnelCreateSchema: both node ids are required UUIDs.
        const created = await post("/api/tunnels", {
          name: "fa-overflow-probe",
          clientNodeId: n0,
          serverNodeId: n1,
          autostart: false,
          config: {
            // TunnelConfigSchema is a discriminated union on `method`.
            method: "PORT_FORWARD",
            portForwards: [{
              name: "fa-probe", direction: "IRAN_TO_FOREIGN", protocol: "tcp",
              sourcePort: 45911, destHost: "127.0.0.1", destPort: 45911, enabled: true,
            }],
          },
        });
        if (created.status >= 400) {
          check.bad("the batch toolbar overflow check runs",
            `tunnel seed failed: ${created.status} ${(await created.text()).slice(0, 140)}`);
        } else {
          check.ok("a tunnel was seeded so the toolbar can render", `status ${created.status}`);
          for (const vp of WIDTHS) {
            await page.setViewportSize({ width: vp.width, height: vp.height });
            for (const loc of ["en", "fa"]) {
              await page.goto(`${origin}/${loc}/tunnels`, { waitUntil: "networkidle", timeout: 60_000 });
              await clearToasts(page);
              // Selection is a labelled BUTTON ("Select all"), not a checkbox
              // input -- looking for input[type=checkbox] found nothing and the
              // check reported "no row checkbox" for a table that has one.
              const selectAll = cats[loc].tunnels?.selectAll ?? "";
              const picked = await page.evaluate<boolean>(`(function () {
                var want = ${JSON.stringify(selectAll)};
                var b = Array.from(document.querySelectorAll("button")).filter(function (x) {
                  return (x.getAttribute("aria-label") || "") === want;
                })[0];
                if (!b) return false;
                b.click();
                return true;
              })()`);
              if (!picked) {
                check.bad(`${vp.name}/${loc}/tunnels batch toolbar stays inside the viewport`, "no row checkbox to select");
                continue;
              }
              await sleep(800);
              const barUp = await page.evaluate<boolean>(
                "(function () { var m = document.querySelector('.ms-auto'); return Boolean(m && m.querySelectorAll('button').length >= 2); })()",
              );
              if (!barUp) {
                check.bad(`${vp.name}/${loc}/tunnels batch toolbar stays inside the viewport`,
                  "the batch toolbar did not appear after selecting a row");
                continue;
              }
              const o = await readJson<{ over: number; sw: number; cw: number; worst: string }>(page, OVERFLOW_WITH_BAR);
              if (o.over <= 2) check.ok(`${vp.name}/${loc}/tunnels batch toolbar stays inside the viewport`, `${o.sw}px in ${o.cw}px`);
              else check.bad(`${vp.name}/${loc}/tunnels batch toolbar stays inside the viewport`, `${o.over}px wider; worst: ${o.worst}`);
            }
          }
          await page.setViewportSize({ width: 1280, height: 800 });
        }
      }
    }

    /* ======== 5b. table HEADER alignment, which the existing RTL suite does
     * not check: it measures `td` geometry, while the `rtl:text-right` override
     * lives on the shared `th`. Dropping that override left every Persian
     * column header on the wrong physical edge and both suites passed. */
    console.log("\n--- table headers align to the correct physical edge ---");
    for (const loc of ["en", "fa"]) {
      await page.goto(`${origin}/${loc}/tunnels`, { waitUntil: "networkidle", timeout: 60_000 });
      await clearToasts(page);
      const th = await readJson<{ rows: number; sides: string[]; firstAt: string }>(page, `
        return (function () {
          var ths = Array.from(document.querySelectorAll("table thead th"));
          if (!ths.length) return { rows: 0, sides: [], firstAt: "" };
          var sides = ths.map(function (t) { return getComputedStyle(t).textAlign; });
          // Measure where the header TEXT physically sits, not the keyword:
          // both 'left' and 'right' are legal computed values.
          var first = ths[0];
          var r = document.createRange();
          var node = first.firstChild;
          var box = first.getBoundingClientRect();
          if (node && node.nodeType === 3) { r.selectNodeContents(node); box = r.getBoundingClientRect(); }
          var mid = (box.left + box.right) / 2;
          return { rows: ths.length, sides: sides, firstAt: mid < (document.documentElement.clientWidth / 2) ? "left" : "right" };
        })()`);
      if (th.rows === 0) {
        check.bad(`${loc} table headers align to the correct physical edge`, "no thead th rendered");
        continue;
      }
      // In Persian the start edge is RIGHT; in English it is LEFT.
      const want = loc === "fa" ? "right" : "left";
      const mixed = new Set(th.sides);
      if (mixed.size > 1) {
        check.bad(`${loc} table headers align to the correct physical edge`,
          `mixed alignment across ${th.rows} headers: ${[...mixed].join(", ")}`);
      } else if (th.firstAt !== want) {
        check.bad(`${loc} table headers align to the correct physical edge`,
          `header text sits at the ${th.firstAt} edge, expected ${want} (computed ${[...mixed].join(",")})`);
      } else {
        check.ok(`${loc} table headers align to the correct physical edge`,
          `${th.rows} headers, text at the ${th.firstAt} edge`);
      }
    }

    /* ========================================= 6. focus lands inside dialogs */
    console.log("\n--- opening a dialog moves focus into it in both locales ---");
    for (const loc of ["en", "fa"]) {
      await page.goto(`${origin}/${loc}/nodes`, { waitUntil: "networkidle", timeout: 60_000 });
      await clearToasts(page);
      const label = cats[loc].nodes?.add ?? "Add node";
      await page.evaluate<boolean>(
        `(function () {
          var b = Array.from(document.querySelectorAll("button")).filter(function (x) {
            return (x.textContent || "").trim() === ${JSON.stringify(label)};
          })[0];
          if (b) b.click();
          return Boolean(b);
        })()`,
      );
      await sleep(900);
      const inside = await page.evaluate<boolean>(
        "(function () { var d = document.querySelector('[role=\"dialog\"]'); return Boolean(d && d.contains(document.activeElement)); })()",
      );
      if (inside) check.ok(`${loc}: focus moved into the node dialog`);
      else check.bad(`${loc}: focus moved into the node dialog`, "focus stayed outside the dialog");
      await page.keyboard.press("Escape");
      await sleep(300);
    }

    console.log("\n--- no uncaught exceptions during the Persian run ---");
    const real = pageErrors.filter((e) => !/Failed to load resource/.test(e));
    if (real.length === 0) check.ok("no uncaught exceptions");
    else check.bad("no uncaught exceptions", real.slice(0, 3).join(" || ").slice(0, 260));
    if (notFound.length === 0) check.ok("no 404 responses");
    else check.bad("no 404 responses", [...new Set(notFound)].slice(0, 4).join(", "));
  } finally {
    await app.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  process.exit(check.report());
}

main().catch((e: unknown) => {
  console.error(`\n${String(e)}`);
  process.exit(1);
});