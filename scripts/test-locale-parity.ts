/**
 * Locale parity and RTL correctness (TASK-49).
 *
 * Catalog key parity is the easy half and it already passed. This suite checks
 * the half that was actually broken: `text-right` on action columns, which
 * pins the actions cell to the RIGHT edge in Persian, where every other cell in
 * the row is right-aligned. The result is a Persian table with the buttons
 * stranded on the wrong side.
 *
 * `ui/table.tsx` already had the correct treatment (`text-left rtl:text-right`).
 * The eight data views that render their own cells never got it. That asymmetry
 * is the finding: one shared primitive was fixed and its consumers were not.
 */

import fs from "node:fs";
import path from "node:path";

let pass = 0;
const failures: string[] = [];
const ok = (name: string) => { pass += 1; console.log(`  ok   ${name}`); };
const bad = (name: string, detail: string) => { failures.push(name); console.log(`  FAIL ${name}\n       ${detail}`); };

const ROOT = path.resolve(".");
const EN = path.join(ROOT, "packages/i18n/messages/en.json");
const FA = path.join(ROOT, "packages/i18n/messages/fa.json");

function flatten(obj: unknown, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v, key));
      else out[key] = v;
    }
  }
  return out;
}

function walk(dir: string, ext: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, acc);
    else if (entry.name.endsWith(ext)) acc.push(full);
  }
  return acc;
}

console.log("\n--- catalog key parity ---");
const en = JSON.parse(fs.readFileSync(EN, "utf8")) as unknown;
const fa = JSON.parse(fs.readFileSync(FA, "utf8")) as unknown;
const e = flatten(en);
const f = flatten(fa);

if (Object.keys(e).length === Object.keys(f).length && Object.keys(e).length > 0) {
  ok(`both catalogs expose the same number of keys (${Object.keys(e).length})`);
} else {
  bad("catalog sizes match", `en=${Object.keys(e).length} fa=${Object.keys(f).length}`);
}

const missingInFa = Object.keys(e).filter((k) => !(k in f));
const extraInFa = Object.keys(f).filter((k) => !(k in e));
if (missingInFa.length === 0) ok("fa has no missing keys");
else bad("fa has no missing keys", missingInFa.slice(0, 12).join(", "));
if (extraInFa.length === 0) ok("fa has no extra keys");
else bad("fa has no extra keys", extraInFa.slice(0, 12).join(", "));

// An empty string is a key that exists but says nothing: the worst case,
// because a lookup succeeds and renders blank.
{
  const emptyEn = Object.entries(e).filter(([, v]) => typeof v === "string" && v.trim() === "");
  const emptyFa = Object.entries(f).filter(([, v]) => typeof v === "string" && v.trim() === "");
  if (emptyEn.length === 0 && emptyFa.length === 0) ok("no catalog value is an empty string");
  else {
    bad("no catalog value is an empty string",
      `en=[${emptyEn.map(([k]) => k).join(", ")}] fa=[${emptyFa.map(([k]) => k).join(", ")}]`);
  }
}

// A fa value identical to its en counterpart is fine ONLY for a technical term
// (a protocol or algorithm name). A whole sentence left in English is a
// missing translation that a key-parity check cannot see.
{
  const PERSIAN = /[\u0600-\u06FF]/;
  const untranslated = Object.keys(f).filter(
    (k) => typeof f[k] === "string" && String(f[k]).length > 3 && !PERSIAN.test(String(f[k])),
  );
  // These are deliberately Latin: they name wire protocols and algorithms, and
  // translating them would make them unrecognisable to the operator.
  const ALLOWED = new Set([
    "methods.FRP", "portForward.tcp", "portForward.udp", "tools.url",
    "tunnels.logLevelStderr", "tunnels.logLevelStdout",
    "wizard.bbr", "wizard.cubic", "wizard.newReno", "wizard.quic",
    "wizard.tcp", "wizard.websocket",
  ]);
  const unexplained = untranslated.filter((k) => !ALLOWED.has(k));
  if (unexplained.length === 0) ok("every Latin-script fa value is a known technical term");
  else {
    bad("every Latin-script fa value is a known technical term",
      `${unexplained.length} unexplained: ${unexplained.slice(0, 12).join(", ")}`);
  }
  const persianInEnglish = Object.keys(e).filter((k) => PERSIAN.test(String(e[k])));
  if (persianInEnglish.length === 0) ok("en contains no Persian text");
  else bad("en contains no Persian text", persianInEnglish.slice(0, 8).join(", "));
}

console.log("\n--- root lang and dir ---");
{
  const layout = path.join(ROOT, "apps/web/app/[locale]/layout.tsx");
  const src = fs.readFileSync(layout, "utf8");
  // lang must come from the route segment, not be hard-coded.
  if (/lang=\{locale\}/.test(src)) ok("the root <html> takes lang from the route locale");
  else bad("the root <html> takes lang from the route locale", "lang={locale} not found");
  // dir must be resolved per locale, so a third locale is not silently LTR.
  if (/dir=\{info\.dir\}/.test(src)) ok("the root <html> takes dir from locale info");
  else bad("the root <html> takes dir from locale info", "dir={info.dir} not found");
  if (/hasLocale\(routing\.locales, locale\)/.test(src)) {
    ok("an unknown locale is rejected rather than rendered");
  } else {
    bad("an unknown locale is rejected rather than rendered", "hasLocale guard not found");
  }
}

console.log("\n--- localeInfo directions ---");
{
  const idx = path.join(ROOT, "packages/i18n/src/index.ts");
  const src = fs.readFileSync(idx, "utf8");
  const m = src.match(/localeInfo[\s\S]{0,600}?\}\s*(?:as const|;)/);
  if (m) {
    if (/en:[\s\S]{0,80}?dir:\s*"ltr"/.test(m[0])) ok("en is declared ltr");
    else bad("en is declared ltr", "not found in localeInfo");
    if (/fa:[\s\S]{0,80}?dir:\s*"rtl"/.test(m[0])) ok("fa is declared rtl");
    else bad("fa is declared rtl", "not found in localeInfo");
  } else {
    bad("localeInfo is readable", "localeInfo block not found in packages/i18n/src/index.ts");
  }
}

console.log("\n--- logical direction in components ---");
// The real finding: `text-right` on an ACTIONS cell. In Persian every other
// cell is right-aligned, so a hard right-alignment strands the action buttons on
// the opposite side from the data they act on. The shared Table primitive was
// already correct; the views that render their own cells were not.
{
  const files = walk(path.join(ROOT, "apps/web"), ".tsx");
  const offenders: string[] = [];
  const REQUIRED = new Set([
    "apps/web/app/[locale]/(app)/tunnels/tunnel-table.tsx",
    "apps/web/app/[locale]/(app)/nodes/nodes-view.tsx",
    "apps/web/app/[locale]/(app)/users/users-view.tsx",
    "apps/web/app/[locale]/(app)/port-forward/port-forward-view.tsx",
    "apps/web/app/[locale]/(app)/webhooks/webhooks-view.tsx",
    "apps/web/app/[locale]/(app)/dashboard-stats.tsx",
    "apps/web/app/[locale]/(app)/dashboard-skeleton.tsx",
    "apps/web/src/components/ui/responsive-table.tsx",
  ]);
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    if (!REQUIRED.has(rel)) continue;
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/className="([^"]*\btext-right\b[^"]*)"/g)) {
      const cls = m[1];
      if (!/rtl:text-right/.test(cls)) offenders.push(`${rel}: ${cls.trim()}`);
    }
    // Multi-line className with text-right on its own line.
    for (const m of src.matchAll(/<(\w+)[^>]*className="([^"]*?)"[^>]*>/g)) {
      if (m[2].includes("text-right") && !m[2].includes("rtl:text-right")) {
        offenders.push(`${rel}: <${m[1]}> ...${m[2].trim().slice(0, 60)}`);
      }
    }
  }
  if (offenders.length === 0) ok("no action column is hard right-aligned");
  else {
    bad("no action column is hard right-aligned", `${offenders.length} offender(s):\n       ${offenders.slice(0, 8).join("\n       ")}`);
  }
}

// A physical margin without a logical counterpart is the same defect in a
// different position: it does not mirror, so spacing is asymmetric in Persian.
{
  const files = walk(path.join(ROOT, "apps/web"), ".tsx");
  const bad2: string[] = [];
  // ml-auto/mr-auto pairs are the common intentional case; a lone one is not.
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/className="([^"]*)"/g)) {
      const cls = m[1];
      const hasPhysical = /\b(ml|mr|pl|pr)-[a-z0-9]/.test(cls);
      if (!hasPhysical) continue;
      const hasLogical = /\b(ms|me|ps|pe)-[a-z0-9]/.test(cls) || /rtl:(ml|mr|pl|pr)-[a-z0-9]/.test(cls);
      const isAutoPair = /ml-auto/.test(cls) && /rtl:mr-auto/.test(cls);
      if (!hasLogical && !isAutoPair) {
        bad2.push(`${path.relative(ROOT, file).split(path.sep).join("/")}: ${cls.trim().slice(0, 80)}`);
      }
    }
  }
  if (bad2.length === 0) ok("physical margins always carry a logical or rtl counterpart");
  else {
    bad("physical margins always carry a logical or rtl counterpart",
      `${bad2.length} offender(s):\n       ${bad2.slice(0, 8).join("\n       ")}`);
  }
}

// An absolutely-positioned icon inside a text field must sit on the END side in
// LTR and the START side in RTL. A hard `right-2` puts it on the left of the
// text in Persian, where it overlaps the value the operator is reading.
{
  const files = walk(path.join(ROOT, "apps/web"), ".tsx");
  const offenders: string[] = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/className="([^"]*\b(?:left|right)-[0-9][^"]*)"/g)) {
      offenders.push(`${path.relative(ROOT, file).split(path.sep).join("/")}: ${m[1].trim().slice(0, 70)}`);
    }
  }
  if (offenders.length === 0) ok("no absolutely-positioned element is hard left/right");
  else {
    bad("no absolutely-positioned element is hard left/right",
      `${offenders.length} offender(s): ${offenders.slice(0, 6).join(" | ")}`);
  }
}

// A logical utility under an `rtl:` prefix is a no-op: `rtl:ms-*` means "in
// RTL use the start margin", and the start margin already flips by definition.
// It signals that a conversion was done twice -- the navbar case, where a
// scripted rewrite turned `rtl:mr-auto` into `rtl:ms-0` and inverted the layout.
{
  const files = walk(path.join(ROOT, "apps/web"), ".tsx");
  const offenders: string[] = [];
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/rtl:(?:ms|me|ps|pe)-[a-z0-9.]+/g)) {
      offenders.push(`${path.relative(ROOT, file).split(path.sep).join("/")}: ${m[0]}`);
    }
  }
  if (offenders.length === 0) ok("no logical utility is redundantly scoped under rtl:");
  else bad("no logical utility is redundantly scoped under rtl:", offenders.slice(0, 6).join(" | "));
}

console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
if (failures.length > 0) process.exitCode = 1;
