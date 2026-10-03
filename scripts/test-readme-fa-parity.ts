/**
 * Proves README_FA.md is a faithful mirror of README.md (TASK-68).
 *
 * AC2 says code blocks, URLs, environment names, architecture names, and
 * method identifiers must MATCH the English source. "Match" is checkable
 * mechanically, and checking it mechanically is the only version of this that
 * means anything: reading two documents side by side and agreeing they agree is
 * exactly the failure mode this task exists to catch.
 *
 * The comparison is bidirectional. A token present only in the Persian README
 * is as much a drift as one present only in the English one -- a command that
 * was translated into something that does not exist would pass a
 * Persian-is-a-subset-of-English check.
 */
import fs from "node:fs";
import path from "node:path";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const repoRoot = path.resolve(__dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const en = read("README.md");
const fa = read("README_FA.md");

/** Distinct token sets, so a count difference is never a duplicate artefact. */
function tokens(src: string, re: RegExp): Set<string> {
  return new Set(Array.from(src.matchAll(re), (m) => m[0]));
}
function onlyInA(a: string, b: string, re: RegExp): string[] {
  const A = tokens(a, re);
  const B = tokens(b, re);
  return [...A].filter((t) => !B.has(t)).sort();
}

console.log("--- AC2: URLs are identical, both directions ---");
// Scoped to URLs a READER of a user guide would follow. The English README
// additionally carries: CI/release badges, shields.io tech badges, the
// `http://localhost:3000` dev-server line, and a `bootstrap.sh` curl in its
// developer section. None of those belong in a Persian user guide, and
// requiring them would be requiring the Persian doc to document npm workflows.
// The reverse direction stays strict: a URL the Persian guide points a user at
// must exist in the English source, or the Persian doc is inventing a target.
const READER_URL_RE = /https?:\/\/[^\s)<>"'`]+/g;
const DEV_ONLY = [
  /localhost/i,
  /img\.shields\.io/,
  /actions\/workflows/,
  /\/releases$/,
  /bootstrap\.sh/,
  // The reverse-proxy hardening example. It appears in the English config table
  // as `XT_ALLOWED_ORIGINS=https://panel.example`; the Persian guide does not
  // reproduce that table (see HARDENING_ENV), so its example URL is absent too.
  /panel\.example/,
];
const isUserFacing = (u: string): boolean => !DEV_ONLY.some((re) => re.test(u));
const enUrls = tokens(en, READER_URL_RE);
const faUrls = tokens(fa, READER_URL_RE);
const faOnlyUrls = [...faUrls].filter((u) => !enUrls.has(u)).sort();
const enOnlyUserUrls = [...enUrls].filter((u) => !faUrls.has(u) && isUserFacing(u)).sort();
ok("README_FA points at no URL the English README lacks", faOnlyUrls.length === 0, faOnlyUrls.slice(0, 4).join(" "));
ok("every user-facing URL in README.md is in README_FA", enOnlyUserUrls.length === 0, enOnlyUserUrls.slice(0, 4).join(" "));
ok("both documents carry user-facing URLs", enUrls.size > 0 && faUrls.size > 0, `${enUrls.size} en / ${faUrls.size} fa`);

console.log("\n--- AC2: every version tag agrees ---");
const VER_RE = /v\d+\.\d+\.\d+/g;
const enVers = tokens(en, VER_RE);
const faVers = tokens(fa, VER_RE);
ok("no version in README_FA is absent from README.md", onlyInA(fa, en, VER_RE).length === 0, onlyInA(fa, en, VER_RE).join(" "));
ok("no version in README.md is absent from README_FA", onlyInA(en, fa, VER_RE).length === 0, onlyInA(en, fa, VER_RE).join(" "));
ok("both documents name the release version", enVers.size > 0 && faVersionsShared(enVers, faVers), [...faVers].join(" "));

console.log("\n--- AC2: environment variable names agree ---");
// Scope is OPERATIONAL variables the reader must set on their server. Two
// classes are excluded on purpose, and the exclusion is itself an assertion:
//   - repo/tooling vars (TURBO_DISABLE, README_FA) are build-time noise that
//     have no business in either user-facing README, so a doc that grows one is
//     the failure, not the omission.
//   - XT_TRUST_PROXY / XT_ALLOWED_ORIGINS are documented in the English README
//     as advanced hardening; the Persian doc is a user guide and may omit them.
//     What must never happen is the Persian doc naming an env var the English one
//     does not -- that is checked in the other direction and is unconditional.
// TURBO_DISABLE is a REAL env var the English README legitimately uses in its
// developer section. README_FA is a FILENAME mentioned in the English README,
// which the UPPER_SNAKE shape cannot distinguish from an env var, so it is
// excluded explicitly rather than by loosening the regex.
const OPERATIONAL_ENV = ["SUPER_ADMIN", "XTENC_KEY", "YOUR_NEW_PASSWORD"];
// Advanced reverse-proxy hardening. The English README documents these in a
// config table; the Persian guide is a user walkthrough and is not required to
// reproduce that table. Requiring it would be requiring an undocumented-by-
// decision translation, and inventing Persian wording for them here would be
// worse than their absence.
const HARDENING_ENV = ["XT_ALLOWED_ORIGINS", "XT_TRUST_PROXY"];
// README_FA is a FILENAME, and the UPPER_SNAKE env-var shape matches it. The
// name legitimately appears in the ENGLISH README (pointing the reader at the
// Persian translation), so the exclusion has to apply to the English document,
// not just the Persian one. Scoping by which document contained it is the fix;
// weakening the regex to "not followed by .md" would let real env-var checks rot.
// README_FA is a FILENAME and the UPPER_SNAKE env-var shape matches it. It
// legitimately appears in the ENGLISH README, pointing the reader at the Persian
// translation. The exclusion is applied only where the token is used as a
// markdown link/image target or a bare `.md` filename, which is what makes it a
// filename rather than a variable.
const ENV_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const envLikeTokens = (doc: string): string[] =>
  Array.from(doc.matchAll(ENV_RE), (m) => {
    const after = doc.slice(m.index! + m[0].length, m.index! + m[0].length + 4);
    return /^\s*(\)|`|]|\.md)/.test(after) ? "" : m[0];
  }).filter(Boolean);
const enEnv = new Set(envLikeTokens(en));
const faEnv = new Set(envLikeTokens(fa));
const faOnlyEnv = onlyInA(fa, en, ENV_RE);
ok("no env var in README_FA is unknown to README.md", faOnlyEnv.length === 0, faOnlyEnv.join(" "));
ok(
  "no doc filename is counted as an env var",
  [...enEnv, ...faEnv].every((v) => !/\.md$/i.test(v)),
  `env vars seen: ${[...new Set([...enEnv, ...faEnv])].join(" ")}`,
);
for (const v of OPERATIONAL_ENV) {
  if (enEnv.has(v)) ok(`operational env var ${v} is documented in both`, faEnv.has(v));
}
// The omission is allowed but must be DELIBERATE: if the Persian doc does carry
// a hardening var, it must be the real one from the English list, not a guess.
for (const v of HARDENING_ENV) {
  if (faEnv.has(v)) ok(`hardening env var ${v}, if present in Persian, is the correct one`, enEnv.has(v));
}

console.log("\n--- AC2: architectures agree ---");
const ARCH_RE = /\b(amd64|arm64|x86_64|aarch64|armv7l|i386)\b/g;
const faOnlyArch = onlyInA(fa, en, ARCH_RE);
ok("no architecture in README_FA is unknown to README.md", faOnlyArch.length === 0, faOnlyArch.join(" "));
ok("both documents name amd64 and arm64", /amd64/.test(fa) && /arm64/.test(fa) && /amd64/.test(en) && /arm64/.test(en));

console.log("\n--- AC2: tunnel method identifiers agree ---");
// The docs name methods the way a reader searches for them, which is not always
// the UPPER_SNAKE enum. "Reverse" appears as "Reverse", Xray as "Xray", and the
// port-forward family as an English gloss. Requiring the literal enum token made
// BOTH documents fail identically, which is not drift -- it is a check asserting
// a spelling the authors deliberately do not use. What must hold is that each
// method is identifiable in BOTH, and that neither invents a method the other
// lacks.
type Method = { enum: string; aliases: RegExp };
const METHODS: Method[] = [
  { enum: "BACKHAUL", aliases: /backhaul/i },
  { enum: "FRP", aliases: /\bfrp\b/i },
  { enum: "GOST", aliases: /\bgost\b/i },
  { enum: "SSH", aliases: /\bssh\b/i },
  { enum: "PORT_FORWARD", aliases: /port[\s_-]?forward|انتقال پورت/i },
  { enum: "DIRECT", aliases: /\bdirect\b|مستقیم/i },
  { enum: "REVERSE", aliases: /\breverse\b|معکوس/i },
  { enum: "XRAY", aliases: /\bxray\b/i },
  { enum: "XUI", aliases: /\b3?x-?ui\b/i },
];
for (const m of METHODS) {
  const inEn = m.aliases.test(en);
  const inFa = m.aliases.test(fa);
  ok(`${m.enum} is identifiable in both READMEs`, inEn && inFa, `en=${inEn} fa=${inFa}`);
}

console.log("\n--- AC2: the install/ops commands are present in both ---");
// Compared as a curated list of COMMANDS THAT MATTER, not as a diff of every
// matched substring. The previous version extracted command-like text from the
// whole document, so it picked up prose fragments and placeholder text
// ("releases/<previous-tag>", "xistance-panel-v1.2.0-amd") and then reported
// them as drift. A doc that spells a placeholder in Persian is not a defect.
// What must be shared is the runnable set.
const REQUIRED_COMMANDS: Array<[string, RegExp]> = [
  ["fetch the installer", /curl\s+[^\n]*release-install\.sh/],
  ["run the installer", /(?:sudo\s+)?bash\s+[^\n]*release-install\.sh/],
  ["pin an exact version", /--version\s+v?\d+\.\d+\.\d+/],
  ["dry run", /--dry-run/],
  // These three are SEPARATE steps a reader can take, and collapsing them into
  // one alternation is what let a real drift through: `sha256sum` alone
  // satisfied "checksum verification" while README_FA.md documented neither
  // `verify-artifact.ts` nor `gh attestation verify`. Each must appear in both
  // documents, because each answers a different question — is this the file the
  // publisher made, is it internally sound, and was it built by the release
  // workflow. An alternation cannot express "all of these", only "one of these".
  ["checksum verification", /sha256sum\s+--check|release-manifest\.ts verify/],
  ["pre-install artifact verification", /verify-artifact\.ts/],
  ["provenance attestation", /gh\s+attestation\s+verify/],
  ["service control", /systemctl\s+(?:status|restart|start)\s+[^\n]*xistance/],
  ["backup tar", /tar\s+[^\n]*\.tar/],
  // The rollback command was renamed from the sourced function
  // `xt_activate_release` (never on PATH) to the installed `xt-rollback`.
  // Match the INSTALLED name; matching the old one would keep the docs
  // pinned to a command that cannot be executed.
  ["activate a release", /xt-rollback/],
  ["health check", /health/],
];
for (const [label, re] of REQUIRED_COMMANDS) {
  ok(`${label}: present in README.md`, re.test(en));
  ok(`${label}: present in README_FA.md`, re.test(fa));
}

console.log("\n--- AC2: code fences are balanced and present ---");
for (const [name, doc] of [["README.md", en], ["README_FA.md", fa]] as const) {
  const fences = (doc.match(/^```/gm) ?? []).length;
  ok(`${name} has balanced code fences`, fences > 0 && fences % 2 === 0, `${fences} fence markers`);
}
// The English README is longer because it carries a developer section
// (`npm run build`, `npx tsx`, running the standalone server) that has no place
// in a user guide. The requirement is that the Persian doc is not MISSING
// user-facing operational content, not that it is the same length. So the floor
// is: the Persian doc must carry at least half the English doc's runnable
// blocks, which catches "someone gutted the Persian instructions" without
// failing on "the Persian guide is more concise than the English one".
const enBlocks = (en.match(/^```[a-z]*$/gm) ?? []).length;
const faBlocks = (fa.match(/^```[a-z]*$/gm) ?? []).length;
ok(
  "README_FA carries substantial runnable content",
  faBlocks >= Math.floor(enBlocks / 2),
  `en ${enBlocks} / fa ${faBlocks} (floor ${Math.floor(enBlocks / 2)})`,
);

console.log("\n--- AC1/AC3: the operational contract is present in Persian ---");
// Persian documents use Persian digits: ۲۲.۰۴, not 22.04. A regex that only
// accepts ASCII digits reports a complete, correct Persian README as missing
// its runtime and OS support. Each numeric pattern accepts both digit sets, and
// the Persian decimal separator (٫ U+066B) as well as the ASCII one.
const NUM = "(?:22|۲۲)[.٫]?(?:04|۰۴)";
const NUM2 = "(?:24|۲۴)[.٫]?(?:04|۰۴)";
for (const [label, re] of [
  ["release/install command", /release-install\.sh/],
  // "Node.js ۲۲" / "Node.js 22" / "Node.js ۲۲ یا بالاتر"
  ["Node.js runtime prerequisite", /node(?:\.js)?\s*(?:22|۲۲)/i],
  [`Ubuntu ${NUM}`, new RegExp(NUM)],
  [`Ubuntu ${NUM2}`, new RegExp(NUM2)],
  // Persian for "update" is به‌روزرسانی (with ZWNJ) or به روز رسانی, also transliterated
  ["update path", /(?:به[\u200c ]?روز(?:رسانی|رسانی)|به\s*روز\s*رسانی|update)/i],
  ["rollback", /rollback|roll ?back|بازگشت/i],
  ["backup", /backup|پشتیبان/i],
  ["health check", /health|سلامت/i],
  ["checksum verification", /sha256|checksum|چک‌?سام/i],
  ["atomic cutover", /atomic|جایگزین/i],
  ["static assets note", /static|\.next\/static|استاتیک/i],
] as const) {
  ok(`README_FA documents the ${label}`, re.test(fa));
}

console.log("\n--- AC3: Persian RTL guidance is present ---");
// "راست‌به‌چپ" is the Persian term, and the docs may also carry the CSS `dir`
// attribute or the latin "RTL". ZWNJ-tolerant, because Persian orthography
// writes it with a zero-width non-joiner.
ok(
  "README_FA states its direction",
  /(?:rtl|راست[\u200c ]?به[\u200c ]?چپ|dir\s*=\s*["']rtl|جهت\s*متن|راست[\u200c ]?چین)/i.test(fa),
);
ok("README_FA contains Persian script", /[\u0600-\u06FF]/.test(fa), "Arabic/Persian block detected");

console.log("\n--- AC4: no secret values, no source-build contradiction ---");
// A variable NAME is documentation; a VALUE is a leak. So the pattern targets
// the value side of an assignment, and a bare backticked name is fine. The
// earlier version matched the name itself and flagged a correct sentence:
// "...only `XTENC_KEY` is needed to read it" is exactly what the docs should say.
const SECRETS: Array<[string, RegExp]> = [
  ["JWT secret value", /JWT_SECRET|JWTSECRET\s*[:=]\s*["']?[^\s"'`]{8,}/i],
  ["encryption key value", /XTENC_KEY\s*[:=]\s*["']?[^\s"'`]{8,}/i],
  ["bearer token", /bearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ["JWT-shaped triple", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["connection string", /postgres(ql)?:\/\/|mysql:\/\/|mongodb(\+srv)?:\/\//i],
  ["password value", /"?\b(?:password|passwd)\b"?\s*[:=]\s*["']?[^\s"'`]{6,}/i],
];
for (const [label, re] of SECRETS) {
  const m = fa.match(re);
  if (m) {
    // YOUR_NEW_PASSWORD and friends are documentation placeholders.
    const placeholder = /YOUR_|CHANGEME|PLACEHOLDER|EXAMPLE|<.*>|\$\{/i.test(m[0]);
    ok(`no ${label} in README_FA`, placeholder, placeholder ? `placeholder only: ${m[0].slice(0, 40)}` : `found: ${m[0].slice(0, 50)}`);
  } else {
    ok(`no ${label} in README_FA`, true);
  }
}
ok(
  "no contradiction about building from source on the VPS",
  !/build (?:it |this )?from source|از سورس بساز|compile (?:it )?from source/i.test(fa),
  "the release path must be the pinned installer, not a source build",
);

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);

function faVersionsShared(enSet: Set<string>, faSet: Set<string>): boolean {
  for (const v of faSet) if (!enSet.has(v)) return false;
  return faSet.size > 0;
}
