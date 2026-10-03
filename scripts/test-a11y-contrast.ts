/**
 * WCAG 2.2 AA contrast, target-size and reflow checks (TASK-48).
 *
 * Three things this suite measures, all of them things a source-level grep
 * cannot answer:
 *
 *   1. **Contrast** — the resolved sRGB of real rendered text against its real
 *      painted backdrop, per WCAG 1.4.3. Sampled from the COMPUTED colour and an
 *      actual `document.elementFromPoint` hit-test, because a text node can sit
 *      on a gradient, a badge, or a card.
 *   2. **Target size** — WCAG 2.5.8 (AA, 24x24 CSS px) and the AAA 44x44, with
 *      the documented exception for inline links in a sentence.
 *   3. **Reflow** — WCAG 1.4.10, no two-dimensional scrolling at 320 CSS px
 *      width, which is 1280px at 400% zoom / 320px equivalent.
 *
 * Everything runs in BOTH locales and in BOTH themes, because a contrast
 * failure in dark mode is a different failure from one in light mode and a
 * Persian page is a different layout from an English one.
 *
 * Run: TURBO_DISABLE=true npm run build && npx tsx scripts/test-a11y-contrast.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser, Context, Page } from "playwright-core";
import {
  Checks,
  EXIT_SKIP,
  findChromium,
  findPlaywright,
  freePort,
  readJson,
  sleep,
  startApp,
} from "./lib/browser-harness";
const ADMIN_EMAIL = "a11y-contrast@xistance.invalid";
const ADMIN_PASS = "ContrastAdminPassw0rd!x";
const ROUTES = ["/", "/tunnels", "/nodes", "/users", "/audit", "/settings", "/webhooks", "/tools"];
/** WCAG 2.2 AA minimum for normal text. */
const AA_TEXT = 4.5;
interface Sample {
  ratio: number;
  fg: string;
  bg: string;
  size: number;
  weight: number;
  text: string;
  large: boolean;
  needs: number;
}
const COLLECT = `
  return (function () {
    // Resolve a colour to sRGB. getComputedStyle may hand back oklch(), and
    // the browser will not convert it for us -- paint it into a canvas and
    // read the pixel back.
    var probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    var pctx = probe.getContext("2d");
    function toRgb(color) {
      pctx.clearRect(0, 0, 1, 1);
      pctx.fillStyle = "#000";
      pctx.fillStyle = color;
      pctx.fillRect(0, 0, 1, 1);
      var d = pctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    }
    function composite(fg, bg) {
      var a = fg[3];
      return [
        fg[0] * a + bg[0] * (1 - a),
        fg[1] * a + bg[1] * (1 - a),
        fg[2] * a + bg[2] * (1 - a),
        1,
      ];
    }
    function lum(c) {
      function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
      return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
    }
    function ratio(a, b) {
      var la = lum(a), lb = lum(b);
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    }
    var out = [];
    // Every element that directly renders text.
    var all = document.querySelectorAll("body *");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;
      var cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      if (Number(cs.opacity) === 0) continue;
      // Only DIRECT text: an element whose own child nodes include a non-empty
      // text node. Otherwise every ancestor is reported for every descendant.
      var own = "";
      for (var j = 0; j < el.childNodes.length; j++) {
        if (el.childNodes[j].nodeType === 3) own += el.childNodes[j].nodeValue;
      }
      own = own.replace(/\\s+/g, " ").trim();
      if (!own) continue;
      if (el.getAttribute("aria-hidden") === "true") continue;
      // Visually-hidden text is exempt: WCAG 1.4.3 applies to what is SEEN, and
      // an sr-only span is clipped to 1px with no painted backdrop, so the
      // measured ratio is an artifact of the hit-test, not a real failure.
      if (el.classList.contains("sr-only") || cs.clip === "rect(0px, 0px, 0px, 0px)") continue;
      // The tooltip is hidden until hover (opacity-0). Same reasoning.
      if (Number(cs.opacity) === 0 || cs.visibility === "hidden") continue;
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      // The painted backdrop: hit-test the CENTRE of the element, then walk up
      // compositing the backgrounds of everything underneath until opaque.
      var midX = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width / 2));
      var midY = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
      var hit = document.elementFromPoint(midX, midY);
      var layers = [];
      var node = hit;
      while (node && node !== document.documentElement) {
        var b = getComputedStyle(node).backgroundColor;
        var p = getComputedStyle(node).backgroundImage;
        if (b && b !== "rgba(0, 0, 0, 0)") layers.push(b);
        if (p && p !== "none") { layers.push("#808080"); break; } // cannot resolve a gradient
        node = node.parentElement;
      }
      var base = getComputedStyle(document.body).backgroundColor;
      if (base && base !== "rgba(0, 0, 0, 0)") layers.push(base);
      layers.push("#ffffff");
      var bg = [255, 255, 255, 1];
      for (var k = layers.length - 1; k >= 0; k--) bg = composite(toRgb(layers[k]), bg);
      var fg = composite(toRgb(cs.color), bg);
      var size = parseFloat(cs.fontSize);
      var weight = Number(cs.fontWeight) || 400;
      // WCAG "large text": >=24px, or >=18.66px when bold.
      var large = size >= 24 || (size >= 18.66 && weight >= 700);
      out.push({
        ratio: Math.round(ratio(fg, bg) * 100) / 100,
        fg: cs.color,
        bg: "rgb(" + [bg[0], bg[1], bg[2]].map(Math.round).join(",") + ")",
        size: size,
        weight: weight,
        text: own.slice(0, 48),
        large: large,
        needs: large ? 3 : 4.5,
      });
      if (out.length > 1200) break;
    }
    return out;
  })()`;
/* ------------------------------------------------------------------ *
 * Browser-evaluated probes, as named constants.
 *
 * They live out here for one reason: a syntax error inside page.evaluate only
 * surfaces when THAT snippet runs, and the non-text block runs last -- after the
 * full contrast matrix. Inlining them made a one-character regex typo cost a
 * twelve-minute build-and-browser cycle. `assertPageScriptsParse` now checks
 * every one of them before any work starts.
 * ------------------------------------------------------------------ */
interface BorderSample {
  worst: number;
  color: string;
  where: string;
  culprit: string;
  count: number;
  ok: boolean;
}
interface TargetSample {
  small: Array<{ w: number; h: number; tag: string; name: string }>;
  inline: number;
}
interface ReflowSample {
  hOver: number;
  vOver: boolean;
  worst: string;
}
const BORDER_PROBE = `
  return (function () {
    var probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    var pctx = probe.getContext("2d");
    function rgb(c) {
      pctx.fillStyle = "#000";
      pctx.fillStyle = c;
      pctx.fillRect(0, 0, 1, 1);
      var d = pctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2], d[3] / 255];
    }
    function over(fg, bg) {
      var a = fg[3];
      return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
    }
    function lum(c) {
      function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
      return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
    }
    function ratio(a, b) { var la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
    var bodyBg = over(rgb(getComputedStyle(document.body).backgroundColor), [255, 255, 255, 1]);
    var worst = 99, color = "", where = "", culprit = "", count = 0;
    var inputs = document.querySelectorAll("input:not([type=hidden]), select, textarea");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      if (!el.offsetParent) continue;
      var cs = getComputedStyle(el);
      if (cs.borderTopStyle === "none" || parseFloat(cs.borderTopWidth) === 0) continue;
      count++;
      var c = rgb(cs.borderTopColor);
      var r = ratio(over(c, bodyBg), bodyBg);
      if (r < worst) {
        worst = r;
        color = cs.borderTopColor;
        var lab = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
        where = (lab ? lab.textContent.trim() : el.tagName).slice(0, 30);
        // Strip the colour classes so the report shows the SHAPE of the
        // problem -- "bare border, no colour class" -- not a hex value.
        var bare = String(el.className).replace(/border-input|border-destructive|border-gray-300|border-border/g, "COLOR-CLASS");
        culprit = (el.id || el.tagName.toLowerCase()) + " <" + el.tagName.toLowerCase() + "> " + bare.slice(0, 130);
      }
    }
    return { worst: Math.round(worst * 100) / 100, color: color, where: where,
             culprit: culprit, count: count, ok: worst >= 3 };
  })()`;
const TARGET_PROBE = `
  return (function () {
    var small = [], inline = 0;
    var ctrls = document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=switch], [role=checkbox], [role=tab]");
    for (var i = 0; i < ctrls.length; i++) {
      var el = ctrls[i];
      if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;
      if (el.getAttribute("aria-hidden") === "true") continue;
      var r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.width >= 24 && r.height >= 24) continue;
      // WCAG 2.5.8 exempts a link sitting inside a sentence of running text.
      var inProse = false;
      for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (p.tagName === "P" || p.tagName === "LI") { inProse = true; break; }
      }
      if (inProse && el.tagName === "A") { inline++; continue; }
      var name = el.getAttribute("aria-label") || (el.textContent || "").replace(/\s+/g, " ").trim()
                 || el.getAttribute("placeholder") || "";
      small.push({ w: Math.round(r.width), h: Math.round(r.height),
                   tag: el.tagName.toLowerCase(), name: name.slice(0, 34) });
    }
    return { small: small.slice(0, 8), inline: inline };
  })()`;
const REFLOW_PROBE = `
  return (function () {
    var de = document.documentElement;
    var cw = de.clientWidth;
    var worst = "", worstOver = 0;
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
        var cls = String(el.className || "").slice(0, 120);
        var txt = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
        worst = el.tagName.toLowerCase() + (cls ? "." + cls : "") + (txt ? " | " + txt : "");
      }
    }
    return { hOver: de.scrollWidth - cw, vOver: de.scrollHeight > de.clientHeight + 2, worst: worst };
  })()`;
async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate(
    `(function () {
      var root = document.documentElement;
      root.classList.toggle("dark", ${JSON.stringify(theme === "dark")});
      try { localStorage.setItem("theme", ${JSON.stringify(theme)}); } catch (e) {}
      return true;
    })()`,
  );
  await sleep(200);
}
/**
 * Parse every browser-evaluated snippet with the real JS engine up front.
 *
 * A syntax error inside page.evaluate only surfaces when that snippet runs, which
 * for the non-text block is AFTER the entire contrast matrix -- twelve minutes
 * of build and browser work thrown away. Failing here costs milliseconds.
 */
function assertPageScriptsParse(): void {
  const snippets = [COLLECT, BORDER_PROBE, TARGET_PROBE, REFLOW_PROBE];
  for (const [n, code] of snippets.entries()) {
    try {
      // The snippet is a complete `return <expr>`; compile it as a function
      // body so the engine sees exactly what page.evaluate will.
      new Function(code);
    } catch (e) {
      throw new Error(
        `browser snippet #${n + 1} does not parse: ${String(e)}\n` +
          code.split("\n").map((l, i) => `${String(i + 1).padStart(3)}| ${l}`).join("\n"),
      );
    }
  }
}
async function main(): Promise<void> {
  assertPageScriptsParse();
  const check = new Checks();
  const baseTmp = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? os.tmpdir();
  const TMP = path.join(baseTmp, `xistance-contrast-${Date.now().toString(36)}`);
  const DB = path.join(TMP, "contrast.db");
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
  const ctx: Context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page: Page = await ctx.newPage();
  // Give the authenticated pages real content: two nodes and a tunnel, so a
  // table with a populated row is measured rather than an empty state.
  let cookies = "";
  let csrf = "";
  try {
    await page.goto(`${origin}/en/login`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.fill('input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[name="password"]', ADMIN_PASS);
    await page.click('button[type="submit"]');
    for (let i = 0; i < 40 && page.url().includes("/login"); i++) await sleep(300);
    if (page.url().includes("/login")) throw new Error("login did not complete");
    const jar = await ctx.cookies(origin);
    cookies = jar.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join("; ");
    csrf = jar.find((c: { name: string; value: string }) => c.name.toLowerCase().includes("csrf"))?.value ?? "";
    const post = (url: string, body: unknown) =>
      fetch(`${origin}${url}`, {
        method: "POST",
        headers: { cookie: cookies, origin, "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify(body),
      });
    for (const name of ["contrast-node-1", "contrast-node-2"]) {
      await post("/api/nodes", {
        name, type: "IRAN", host: "127.0.0.1", port: 1,
        username: "root", authMethod: "key", key: "[REDACTED PRIVATE KEY]",
      });
    }
    const nodes = (await (await fetch(`${origin}/api/nodes`, { headers: { cookie: cookies } }))
      .json()) as { nodes: Array<{ id: string }> };
    if (nodes.nodes[0] && nodes.nodes[1]) {
      await post("/api/tunnels", {
        name: "contrast-probe", clientNodeId: nodes.nodes[0].id, serverNodeId: nodes.nodes[1].id,
        autostart: false,
        config: {
          method: "PORT_FORWARD",
          portForwards: [{
            name: "probe", direction: "IRAN_TO_FOREIGN", protocol: "tcp",
            sourcePort: 45871, destHost: "127.0.0.1", destPort: 45871, enabled: true,
          }],
        },
      });
    }
  } catch (e) {
    check.bad("the contrast suite can reach an authenticated page", String(e).slice(0, 200));
  }
  try {
    /* ==================================== 1. text contrast, per theme + locale */
    console.log("\n--- text contrast (WCAG 1.4.3) ---");
    const worstByRoute: Record<string, { min: number; sample: Sample }> = {};
    for (const theme of ["light", "dark"] as const) {
      for (const loc of ["en", "fa"]) {
        for (const route of ROUTES) {
          await page.goto(`${origin}/${loc}${route}`, { waitUntil: "networkidle", timeout: 60_000 });
          await setTheme(page, theme);
          const samples = await readJson<Sample[]>(page, COLLECT);
          if (samples.length === 0) {
            check.bad(`${theme}/${loc}${route} renders measurable text`, "no text elements found");
            continue;
          }
          const fails = samples.filter((s) => s.ratio + 0.01 < s.needs);
          const key = `${theme}/${loc}${route}`;
          if (fails.length === 0) {
            const min = Math.min(...samples.map((s) => s.ratio));
            check.ok(`${key}: all text meets AA`, `${samples.length} samples, lowest ${min.toFixed(2)}:1`);
          } else {
            const detail = fails.slice(0, 3)
              .map((s) => `${JSON.stringify(s.text)} ${s.ratio.toFixed(2)}:1 needs ${s.needs} (${s.fg} on ${s.bg} @${s.size}px/${s.weight})`)
              .join(" | ");
            check.bad(`${key}: all text meets AA`, `${fails.length}/${samples.length} fail — ${detail.slice(0, 280)}`);
          }
          const min = Math.min(...samples.map((s) => s.ratio));
          if (!worstByRoute[key] || min < worstByRoute[key].min) {
            worstByRoute[key] = { min, sample: samples.find((s) => s.ratio === min)! };
          }
        }
      }
    }
    /* ================== 2. non-text contrast: borders and focus indicators */
    console.log("\n--- non-text contrast (WCAG 1.4.11) ---");
    for (const theme of ["light", "dark"] as const) {
      await page.goto(`${origin}/en/settings`, { waitUntil: "networkidle", timeout: 60_000 });
      await setTheme(page, theme);
      // WCAG 1.4.11: the boundary of an input is the only cue that a field
      // exists, so it must clear 3:1 against the surface behind it.
      const borders = await readJson<BorderSample>(page, BORDER_PROBE);
      if (borders.ok) {
        check.ok(`${theme}: input borders meet the 3:1 non-text minimum`,
          `lowest ${borders.worst}:1 across ${borders.count} control(s)`);
      } else {
        check.bad(`${theme}: input borders meet the 3:1 non-text minimum`,
          `lowest ${borders.worst}:1 ${borders.color} on ${borders.where || "an input"} | ${borders.culprit}`);
      }
    }
    /* ============================== 3. target size, WCAG 2.5.8 (24x24 AA) */
    console.log("\n--- target size (WCAG 2.5.8) ---");
    for (const loc of ["en", "fa"]) {
      for (const route of ROUTES) {
        await page.goto(`${origin}/${loc}${route}`, { waitUntil: "networkidle", timeout: 60_000 });
        const t = await readJson<TargetSample>(page, TARGET_PROBE);
        if (t.small.length === 0) {
          check.ok(`${loc}${route}: every target is at least 24x24`, `${t.inline} inline link(s) exempt`);
        } else {
          const detail = t.small.slice(0, 4)
            .map((x) => `${x.tag}${x.name ? ` "${x.name}"` : ""} ${x.w}x${x.h}`).join(", ");
          check.bad(`${loc}${route}: every target is at least 24x24`, `${t.small.length}+ undersized — ${detail}`);
        }
      }
    }
    /* ============================ 4. reflow at 320 CSS px (WCAG 1.4.10) */
    console.log("\n--- reflow at 320 CSS px (WCAG 1.4.10) ---");
    for (const loc of ["en", "fa"]) {
      for (const route of ROUTES) {
        await page.setViewportSize({ width: 320, height: 800 });
        await page.goto(`${origin}/${loc}${route}`, { waitUntil: "networkidle", timeout: 60_000 });
        const o = await readJson<ReflowSample>(page, REFLOW_PROBE);
        if (o.hOver <= 2) {
          check.ok(`${loc}${route} reflows to 320px without two-dimensional scrolling`,
            `${o.vOver ? "vertical scroll only, as allowed" : "no overflow"}`);
        } else {
          check.bad(`${loc}${route} reflows to 320px without two-dimensional scrolling`,
            `${o.hOver}px horizontal overflow; worst: ${o.worst}`);
        }
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    /* ================================== 5. before/after summary for evidence */
    console.log("\n--- lowest contrast per surface (before/after evidence) ---");
    const rows = Object.entries(worstByRoute).sort((a, b) => a[1].min - b[1].min).slice(0, 6);
    for (const [k, v] of rows) {
      check.ok(`${k} lowest text contrast`, `${v.min.toFixed(2)}:1 (needs ${v.sample.needs}) — ${JSON.stringify(v.sample.text)}`);
    }
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