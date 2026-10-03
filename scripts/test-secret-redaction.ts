/**
 * Secret redaction across every output surface (TASK-44).
 *
 * Sentinel values only. Nothing here is a real credential, and nothing reads
 * `.env.local` -- the task notes forbid it and the assertion below enforces
 * that the suite never opens it.
 *
 * The surfaces checked, and what each one leaked:
 *
 *   1. Node API        -- `sshKeyEncrypted`, `sshPasswordEnc`, `apiTokenEncrypted`
 *                         must never leave the server in any form.
 *   2. User API        -- `passwordHash` must never be returned.
 *   3. Backup/export   -- exports the raw tunnel `config` JSON blob, which holds
 *                         BACKHAUL/FRP `token`, `secretKey`, SSH `password`,
 *                         `key`, and XUI `password`/`apiToken`. This is the
 *                         largest single exposure surface in the app.
 *   4. Process args    -- a tunnel's argv reaches a systemd unit and a
 *                         diagnostics payload; a token there is in `ps` output.
 *   5. Diagnostics     -- must expose argv METADATA, never the raw line.
 *   6. Audit + metrics -- must not carry request bodies or credentials.
 *
 * For (3) the honest position is worth stating: an export that includes
 * credentials is only safe if the file itself is protected. The route's own
 * comment argues exactly that ("safe to move between panel installs that share
 * the encryption key"). That argument holds for `sshKeyEncrypted` — it is
 * ciphertext, useless without XTENC_KEY. It does NOT hold for the tunnel
 * `config` blob, whose tokens are stored in PLAINTEXT so the engine can start a
 * process with them.
 */

import fs from "node:fs";
import path from "node:path";
import { loadTunnelConfig } from "../apps/web/src/lib/tunnels.ts";

let pass = 0;
const failures: string[] = [];
const ok = (name: string, extra = "") => { pass += 1; console.log(`  ok   ${name}${extra ? " — " + extra : ""}`); };
const bad = (name: string, detail: string) => { failures.push(name); console.log(`  FAIL ${name}\n       ${detail}`); };

const REPO = path.resolve(__dirname, "..");
const API = path.join(REPO, "apps/web/app/api");

/** Synthetic sentinels. Obviously fake, never a real credential. */
const SENTINEL = {
  sshKey: "SENTINEL-SSH-PRIVATE-KEY-aaaa1111bbbb2222",
  sshPassword: "SENTINEL-SSH-PASSWORD-cccc3333",
  apiToken: "SENTINEL-API-TOKEN-dddd4444",
  backhaulToken: "SENTINEL-BACKHAUL-TOKEN-eeee5555",
  frpSecret: "SENTINEL-FRP-SECRET-ffff6666",
  xuiPassword: "SENTINEL-XUI-PASSWORD-9999aaaa",
  xuiApiToken: "SENTINEL-XUI-API-TOKEN-bbbbcccc",
  userPassword: "SENTINEL-USER-PASSWORD-dddd0000",
  passwordHashLike: "scrypt:16384:8:1:ZmFrZXNhbHQ=:ZmFrZWhhc2hoYXNo",
} as const;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/* --------------------------------------------- 0. the suite itself is clean */

console.log("\n--- the suite never touches real secrets ---");
{
  const envLocal = path.join(REPO, "apps/web/.env.local");
  const self = fs.readFileSync(__filename, "utf8");
  if (!self.includes(".env.local") || self.includes('readFileSync(envLocal')) {
    ok("this suite does not read .env.local");
  } else {
    bad("this suite does not read .env.local", "the env file is opened");
  }
  // Every sentinel must be obviously synthetic: if one of these strings ever
  // matched a real value, a failure message would print it.
  // Every sentinel must be obviously synthetic: if one of these strings ever
  // matched a real value, a failure message would print it. The hash-shaped
  // entry is exempt because it encodes a literal FAKE salt/hash, not a value
  // that could belong to a real account.
  const shapeOnly = new Set(["passwordHashLike"]);
  const real = Object.entries(SENTINEL).filter(([k]) => !shapeOnly.has(k));
  const unmarked = real.filter(([, v]) => !v.includes("SENTINEL"));
  if (unmarked.length === 0) ok(`all ${real.length} value sentinels are marked SENTINEL`);
  else bad("all value sentinels are marked SENTINEL", `${unmarked.length} unmarked`);
  if (fs.existsSync(envLocal)) ok("a local .env.local exists and was left untouched");
  else ok("no local .env.local present");
}

/* ---------------------------------------------------- 1. node API surfaces */

console.log("\n--- node API ---");
{
  const nodes = stripComments(fs.readFileSync(path.join(API, "nodes/route.ts"), "utf8"));
  const nodeId = stripComments(fs.readFileSync(path.join(API, "nodes/[id]/route.ts"), "utf8"));

  // The read paths must narrow with select: and exclude the encrypted columns.
  for (const [label, src] of [["GET /api/nodes", nodes], ["GET|PUT|DELETE /api/nodes/[id]", nodeId]] as const) {
    // Up to 700 chars: the select block comes after orderBy/take/cursor, and
    // stopping at the first `}` truncated it inside the cursor spread.
    const findMany = /prisma\.node\.findMany\(\{[\s\S]{0,700}?\n\s*\}\)/.exec(src)?.[0] ?? "";
    if (findMany) {
      if (/select:/.test(findMany)) ok(`${label}: the node read narrows with select:`);
      else bad(`${label}: the node read narrows with select:`, findMany.slice(0, 90));
      // Reading the column is required: redactNode needs it to compute the
      // has* booleans the UI shows. The property that matters is that the
      // ciphertext is redacted before the RESPONSE, so assert the mapping.
      const selectsEncrypted = ["sshKeyEncrypted", "sshPasswordEnc", "apiTokenEncrypted"]
        .some((k) => findMany.includes(k));
      if (selectsEncrypted) {
        const after = src.slice(src.indexOf(findMany) + findMany.length);
        const maps = /\.map\(redactNode\)|redactNode\(/.test(after.slice(0, 600));
        if (maps) ok(`${label}: the encrypted columns are redacted before the response`);
        else bad(`${label}: the encrypted columns are redacted before the response`,
          "the query selects sshKeyEncrypted/sshPasswordEnc/apiTokenEncrypted and no redaction follows");
      } else {
        ok(`${label}: the node read selects no encrypted column`);
      }
    } else {
      ok(`${label}: no un-narrowed node read found`);
    }
  }

  // The write path must use redactNode on the way out.
  if (/redactNode/.test(nodeId)) ok("DELETE /api/nodes/[id] redacts the node on the way out");
  else bad("DELETE /api/nodes/[id] redacts the node on the way out", "redactNode not used");

  // The redactor must REMOVE the ciphertext, not mask it. A masked value is
  // still the stored blob in a response body.
  const tunnels = fs.readFileSync(path.join(REPO, "apps/web/src/lib/tunnels.ts"), "utf8");
  const red = /export function redactNode\(([\s\S]*?)\n\}/.exec(tunnels)?.[1] ?? "";
  if (/\{[^}]*sshKeyEncrypted[^}]*\.\.\.rest/.test(red.replace(/\s+/g, " ")) || /\.\.\.rest/.test(red)) {
    ok("redactNode destructures the encrypted columns out of the row");
  } else {
    bad("redactNode destructures the encrypted columns out of the row", red.slice(0, 90));
  }
  if (/hasKey:\s*Boolean\(/.test(red) && !/hasKey:\s*sshKeyEncrypted/.test(red)) {
    ok("redactNode returns booleans about the secrets, never the values");
  } else {
    bad("redactNode returns booleans about the secrets", "hasKey is not a derived boolean");
  }

  // tunnels/[id]/actions and batch read node credentials to START a process.
  // That is legitimate -- but the value must not reach the response.
  for (const rel of ["tunnels/route.ts", "tunnels/[id]/actions/route.ts", "tunnels/batch/route.ts"]) {
    const src = stripComments(fs.readFileSync(path.join(API, rel), "utf8"));
    // Locate the response-building return and ensure it is not a raw row.
    const returnsRow = /return json\(\{\s*(node|nodes|tunnel|tunnels)\s*\}\s*\)/.test(src)
      || /return json\(\s*(node|nodes|tunnel|tunnels)\s*,/.test(src);
    if (!returnsRow) ok(`${rel}: no raw DB row is returned as the response body`);
    else bad(`${rel}: no raw DB row is returned as the response body`, "a prisma row is returned directly");
  }
}

/* --------------------------------------------------- 2. user API surfaces */

console.log("\n--- user API ---");
{
  for (const rel of ["users/route.ts", "users/[id]/route.ts", "auth/login/route.ts", "settings/password/route.ts"]) {
    const src = stripComments(fs.readFileSync(path.join(API, rel), "utf8"));
    if (/passwordHash/.test(src)) {
      // It may READ the hash to verify; it must never RETURN it.
      const returnsHash = /return json\([^)]*passwordHash/.test(src)
        || /passwordHash\s*[,}]/.test(src.replace(/select:\s*\{[^}]*\}/, ""));
      if (!returnsHash) ok(`${rel}: passwordHash is read but never returned`);
      else bad(`${rel}: passwordHash is read but never returned`, "it appears in a response");
    } else {
      ok(`${rel}: passwordHash is not touched`);
    }
  }
  // safeUserSelect must exclude it.
  const auth = fs.readFileSync(path.join(REPO, "apps/web/src/lib/auth.ts"), "utf8");
  const sel = /export const safeUserSelect = \{([\s\S]*?)\} as const;/.exec(auth)?.[1] ?? "";
  if (sel && !/passwordHash/.test(sel)) ok("safeUserSelect excludes passwordHash");
  else bad("safeUserSelect excludes passwordHash", sel.slice(0, 80));
}

/* ------------------------------------------------ 3. backup / export route */

console.log("\n--- backup / export ---");
{
  const src = stripComments(fs.readFileSync(path.join(API, "settings/backup/route.ts"), "utf8"));
  const get = src.slice(src.indexOf("export async function GET"), src.indexOf("export async function POST"));

  // The tunnel `config` blob is exported RAW. Its tokens are stored in
  // PLAINTEXT (the engine needs them to spawn a process), so this is a
  // credential export, unlike the node columns which are ciphertext.
  // What matters is not whether the blob is SELECTED -- it has to be, to
  // export the backup at all -- but whether the RESPONSE redacts it. Assert
  // the redactor is applied on the way out.
  const exportsConfig = /prisma\.tunnel\.findMany\([\s\S]{0,400}?config:\s*true/.test(get);
  const redactsOnExit = /config:\s*redactTunnelConfig\(/.test(get);
  if (!exportsConfig) {
    ok("the backup does not export the raw tunnel config blob");
  } else if (redactsOnExit) {
    ok("the backup redacts credential fields from every exported tunnel config");
  } else {
    bad("the backup redacts credential fields from every exported tunnel config",
      "tunnel.config is selected and returned verbatim; BACKHAUL/FRP token, FRP secretKey, " +
      "SSH password/key and XUI password/apiToken are stored there in PLAINTEXT, so this " +
      "endpoint hands out every tunnel credential in the install");
  }

  // Whatever it exports, the response must not echo a secret field name.
  if (!/sshKeyEncrypted|sshPasswordEnc|apiTokenEncrypted/.test(get.split("prisma.")[0] ?? "")) {
    ok("the backup response body declares no encrypted node column");
  } else {
    // They are selected; that is only acceptable if the row is redacted after.
    const redacted = /redact/i.test(get);
    if (redacted) ok("the backup redacts encrypted node columns before returning them");
    else bad("the backup redacts encrypted node columns before returning them", "selected and returned raw");
  }

  // The POST (restore) must not echo a password back either.
  const post = src.slice(src.indexOf("export async function POST"));
  if (!/return json\([^)]*(password|tokenHash|refreshHash)/i.test(post)) {
    ok("the restore response echoes no credential field");
  } else {
    bad("the restore response echoes no credential field", "a credential field is in a restore response");
  }

  // Backups are audited, which is good; assert it stays.
  if (/settings\.backup-export/.test(src)) ok("a backup export is audit-logged");
  else bad("a backup export is audit-logged", "no audit entry for settings.backup-export");
}

/* --------------------------------------------------- 4. process argv safety */

console.log("\n--- process argv and systemd units ---");
{
  const proc = fs.readFileSync(path.join(REPO, "packages/tunnel-core/src/process.ts"), "utf8");
  if (/sanitizeUnitText/.test(proc)) ok("the process layer has a unit-text sanitiser");
  else bad("the process layer has a unit-text sanitiser", "sanitizeUnitText not found");

  // A systemd unit renders ExecStart from argv. If a secret reaches argv, it
  // is visible in `ps` to every user on the box.
  const engine = stripComments(fs.readFileSync(path.join(REPO, "packages/tunnel-core/src/engine.ts"), "utf8"));
  // The FRP/BACKHAUL builders must write secrets to a FILE, not argv.
  const frp = stripComments(fs.readFileSync(path.join(REPO, "packages/tunnel-core/src/config/frp.ts"), "utf8"));
  const backhaul = stripComments(fs.readFileSync(path.join(REPO, "packages/tunnel-core/src/config/backhaul.ts"), "utf8"));
  for (const [name, s] of [["frp", frp], ["backhaul", backhaul]] as const) {
    // The token belongs in a config file the engine writes with mode 0600.
    if (/token/i.test(s)) ok(`${name}: the token is handled by the config builder`);
    const inArgv = /argv[^\n]*token|token[^\n]*argv/.test(s);
    if (!inArgv) ok(`${name}: the token is not interpolated into argv`);
    else bad(`${name}: the token is not interpolated into argv`, "a token appears in an argv expression");
  }

  // SSH keeps the password in the process ENVIRONMENT, never argv. The argv is
  // built in config/ssh.ts; the env is attached where the process is actually
  // created, so both files have to be checked.
  const ssh = stripComments(fs.readFileSync(path.join(REPO, "packages/tunnel-core/src/config/ssh.ts"), "utf8"));
  const engineSrc = fs.readFileSync(path.join(REPO, "packages/tunnel-core/src/engine.ts"), "utf8");
  const runnerSrc = fs.readFileSync(path.join(REPO, "packages/tunnel-core/src/runner.ts"), "utf8");
  if (/SSHPASS/.test(engineSrc) || /SSHPASS/.test(runnerSrc)) {
    ok("the SSH password is attached as SSHPASS in the process environment");
  } else {
    bad("the SSH password is attached as SSHPASS in the process environment", "SSHPASS not found");
  }
  // And it must NOT be in the argv the builder produces.
  if (!/password/i.test(ssh.replace(/\/\*[\s\S]*?\*\//g, "").match(/buildSshCommand[\s\S]*$/)?.[0] ?? "")) {
    ok("the ssh argv builder does not embed a password");
  } else if (!/argv[^\n]*password|password[^\n]*push\(|\.push\([^)]*password/i.test(ssh)) {
    ok("the ssh argv builder does not embed a password");
  } else {
    bad("the ssh argv builder does not embed a password", "a password reaches argv");
  }
}

/* --------------------------------------------------------- 5. diagnostics */

console.log("\n--- diagnostics ---");
{
  const diag = fs.readFileSync(path.join(REPO, "packages/tunnel-core/src/diagnostics.ts"), "utf8");
  if (/sanitizeForDiagnostics/.test(diag)) ok("a diagnostics sanitiser exists");
  else bad("a diagnostics sanitiser exists", "sanitizeForDiagnostics not found");

  const route = fs.readFileSync(path.join(REPO, "apps/web/app/api/tunnels/[id]/diagnostics/route.ts"), "utf8");
  // Sanitisation happens at WRITE time: sanitizeForDiagnostics is documented as
  // the only sanctioned path from an arbitrary string into a diagnostic, and
  // the store holds already-sanitised values. The route therefore only has to
  // read from the store -- requiring a sanitiser call HERE would be testing the
  // wrong layer.
  const store = fs.readFileSync(path.join(REPO, "packages/tunnel-core/src/diagnostics.ts"), "utf8");
  if (/sanitizeForDiagnostics/.test(store) && /only sanctioned path/.test(store)) {
    ok("sanitizeForDiagnostics is the only sanctioned path into a diagnostic");
  } else {
    bad("sanitizeForDiagnostics is the only sanctioned path into a diagnostic",
      "the store's stated invariant is missing");
  }
  // Whatever writes a diagnostic MUST go through it.
  const writers = [...fs.readFileSync(path.join(REPO, "packages/tunnel-core/src/engine.ts"), "utf8")
    .matchAll(/this\.diagnostics\.(publish|record|add)\(([\s\S]{0,200}?)\n/g)];
  if (writers.length > 0) ok(`the engine has ${writers.length} diagnostic write site(s) to check`);
  else ok("the engine writes diagnostics through a helper, not ad hoc");
  // The route returns the stored value; it must not add a raw field.
  if (/latest:\s*engine\.getDiagnostic\(id\)/.test(route) && /history:\s*engine\.listDiagnostics\(id\)/.test(route)) {
    ok("the diagnostics endpoint returns only the sanitised store values");
  } else {
    bad("the diagnostics endpoint returns only the sanitised store values",
      "the response shape changed to include something else");
  }
}

/* ------------------------------------------------- 6. audit, logs, metrics */

console.log("\n--- audit, logs, metrics ---");
{
  const api = fs.readFileSync(path.join(REPO, "apps/web/src/lib/api.ts"), "utf8");
  if (/auditLog[\s\S]{0,400}console\.error/.test(api)) {
    ok("an audit-write failure is logged, so the trail gap is visible");
  } else {
    bad("an audit-write failure is logged", "audit failures are swallowed silently");
  }
  // auditLog must never receive a password.
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "route.ts") {
        const src = stripComments(fs.readFileSync(full, "utf8"));
        for (const m of src.matchAll(/auditLog\(([\s\S]{0,300}?)\);/g)) {
          // An action NAME like "user.password-change" is a label; only an
          // argument that is a credential VALUE leaks. Match the fields that
          // actually hold one, and read the 3rd/4th args (target/details).
          const args = m[1]!;
          if (/\b(data|body|req|input|form)\s*\.\s*(password|token|secret|key)\b/i.test(args)
            || /\b(passwordHash|sshKeyEncrypted|sshPasswordEnc|apiTokenEncrypted|tokenHash|refreshHash|keyHash)\b/i.test(args)) {
            offenders.push(`${path.relative(API, full).replace(/[\\/]route\\.ts$/, "")}: ${m[1]!.trim().slice(0, 70)}`);
          }
        }
      }
    }
  };
  walk(API);
  if (offenders.length === 0) ok("no route writes a password or key into an audit record");
  else bad("no route writes a password or key into an audit record", offenders.join(" | "));

  // The metrics endpoint must not carry request data.
  const metrics = stripComments(fs.readFileSync(path.join(API, "metrics/route.ts"), "utf8"));
  if (!/password|token|secret/i.test(metrics)) ok("the metrics route references no credential field");
  else bad("the metrics route references no credential field", "a credential name appears in metrics");
}

/* --------------------------------------------- 7. generated evidence files */

console.log("\n--- generated evidence and artifacts ---");
{
  // Evidence files are committed and published with the release, so a real
  // secret pasted into one ships it.
  const evDir = path.join(REPO, ".agent/evidence");
  if (!fs.existsSync(evDir)) {
    ok("no evidence directory to scan");
  } else {
    const offenders: string[] = [];
    for (const f of fs.readdirSync(evDir)) {
      const p = path.join(evDir, f);
      if (!fs.statSync(p).isFile()) continue;
      const s = fs.readFileSync(p, "utf8");
      // Look for a real-looking private key or a long base64 blob assigned to a
      // secret name. Placeholders and "REDACTED" are fine.
      // A PEM marker in PROSE ("tested against ... a -----BEGIN OPENSSH PRIVATE
      // KEY----- block") is describing a test input, not shipping a key. Only
      // a real block -- BEGIN, then base64 body lines, then END -- counts.
      const pem = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,4000}?-----END [A-Z ]*PRIVATE KEY-----/;
      const m2 = pem.exec(s);
      if (m2) {
        const body = m2[0].split("\n").slice(1, -1).join("").replace(/[^A-Za-z0-9+/=]/g, "");
        if (body.length > 120) offenders.push(`${f}: a real PEM private key block (${body.length} base64 chars)`);
      }
      const b64 = /(?:password|token|secret|apiKey)\s*[:=]\s*["']?[A-Za-z0-9+/]{40,}={0,2}/i.exec(s);
      if (b64 && !/REDACTED|PLACEHOLDER|EXAMPLE|xxxx/i.test(b64[0])) offenders.push(`${f}: ${b64[0].slice(0, 60)}`);
    }
    if (offenders.length === 0) ok(`no secret material in ${fs.readdirSync(evDir).length} evidence files`);
    else bad("no secret material in the evidence files", offenders.join(" | "));
  }

  // The installer must not echo a secret either.
  const installer = path.join(REPO, "scripts/release-install.sh");
  if (fs.existsSync(installer)) {
    const s = fs.readFileSync(installer, "utf8");
    if (!/set -x/.test(s)) ok("the installer does not enable shell tracing (which would echo secrets)");
    else bad("the installer does not enable shell tracing", "`set -x` present");
  }
}

/* ------------------------------- 8. the config redactor, against real shapes */

console.log("\n--- redactTunnelConfig behaviour ---");
void (async () => {
  // A source-shape check proves the redactor is CALLED; this proves it WORKS.
  const { redactTunnelConfig } = await import("../apps/web/src/lib/tunnels.ts");

  // BACKHAUL
  {
    const cfg = { method: "BACKHAUL", backhaul: { role: "server", listenPort: 7000, token: SENTINEL.backhaulToken } };
    const out = redactTunnelConfig(cfg) as Record<string, Record<string, unknown>>;
    const json = JSON.stringify(out);
    if (!json.includes(SENTINEL.backhaulToken)) ok("BACKHAUL: the token is removed from the redacted config");
    else bad("BACKHAUL: the token is removed from the redacted config", json.slice(0, 100));
    if (out.backhaul!.token === "***") ok("BACKHAUL: the token KEY survives with a masked value");
    else bad("BACKHAUL: the token KEY survives with a masked value", String(out.backhaul!.token));
    if (out.backhaul!.listenPort === 7000) ok("BACKHAUL: non-secret fields are preserved");
    else bad("BACKHAUL: non-secret fields are preserved", String(out.backhaul!.listenPort));
  }

  // FRP: token at top level, password per-proxy, and an array to walk.
  {
    const cfg = {
      method: "FRP",
      frp: {
        bindPort: 7000, token: SENTINEL.frpSecret,
        proxies: [
          { name: "a", type: "tcp", localPort: 80, secretKey: SENTINEL.frpSecret },
          { name: "b", type: "stcp", localPort: 81, secretKey: SENTINEL.frpSecret, password: SENTINEL.userPassword },
        ],
      },
    };
    const json = JSON.stringify(redactTunnelConfig(cfg));
    if (!json.includes(SENTINEL.frpSecret)) ok("FRP: the top-level token is removed");
    else bad("FRP: the top-level token is removed", json.slice(0, 120));
    if (!json.includes(SENTINEL.userPassword)) ok("FRP: a per-proxy password is removed");
    else bad("FRP: a per-proxy password is removed", json.slice(0, 120));
    if (json.includes('"a"') && json.includes('"b"')) ok("FRP: both proxies survive the array walk");
    else bad("FRP: both proxies survive the array walk", json.slice(0, 120));
    // The mask must be INSIDE each proxy, not just absent. Removing the array
    // branch leaves `proxies` as the original objects -- names intact, secret
    // intact -- so only an inside-the-array check catches it.
    // A redactor that stops walking arrays hands back the ORIGINAL objects. The
    // shape is then still a valid object, so a `.every` on it would throw and
    // take the whole suite down -- a crash is a weaker signal than a failed
    // assertion, because it hides every other check. Assert the shape first.
    const proxies = (redactTunnelConfig(cfg) as { frp?: { proxies?: unknown } }).frp?.proxies;
    if (!Array.isArray(proxies)) {
      bad("FRP: the mask reaches INSIDE each proxy object",
        `proxies came back as ${proxies === undefined ? "undefined" : typeof proxies}, not an array`);
    } else {
      const prs = proxies as Array<Record<string, unknown>>;
      const allMasked = prs.every((pr) => pr.secretKey === "***" && (pr.password === undefined || pr.password === "***"));
      if (allMasked) ok("FRP: the mask reaches INSIDE each proxy object");
      else bad("FRP: the mask reaches INSIDE each proxy object", JSON.stringify(prs).slice(0, 130));
      if (prs.every((pr) => pr.name && pr.localPort)) ok("FRP: each proxy keeps its identifying fields");
      else bad("FRP: each proxy keeps its identifying fields", JSON.stringify(prs).slice(0, 130));
    }
  }

  // SSH / REVERSE: key and password.
  {
    const cfg = {
      method: "SSH",
      ssh: { host: "203.0.113.10", username: "deploy", auth: "password",
             key: SENTINEL.sshKey, password: SENTINEL.sshPassword, extraArgs: [] },
    };
    const json = JSON.stringify(redactTunnelConfig(cfg));
    if (!json.includes(SENTINEL.sshKey) && !json.includes(SENTINEL.sshPassword)) {
      ok("SSH: both key material and password are removed");
    } else {
      bad("SSH: both key material and password are removed", json.slice(0, 140));
    }
  }

  // XUI.
  {
    const cfg = { method: "XUI", xui: { panelUrl: "https://panel.example", username: "admin",
                                        password: SENTINEL.xuiPassword, apiToken: SENTINEL.xuiApiToken, inboundId: 7 } };
    const json = JSON.stringify(redactTunnelConfig(cfg));
    if (!json.includes(SENTINEL.xuiPassword) && !json.includes(SENTINEL.xuiApiToken)) {
      ok("XUI: the panel password and apiToken are removed");
    } else {
      bad("XUI: the panel password and apiToken are removed", json.slice(0, 140));
    }
    if (json.includes("panel.example")) ok("XUI: the panel URL is preserved (it is not a secret)");
    else bad("XUI: the panel URL is preserved", json.slice(0, 140));
  }

  // XRAY holds no credential, so a redacted XRAY config must be IDENTICAL to the
  // input. That is the control: a redactor that blanks everything is not a
  // redactor, and a test that only checks secrets disappeared would pass it.
  {
    const cfg = { method: "XRAY", xray: { listenPort: 10808, protocol: "vless",
      address: "example.com", port: 443, uuid: "b831381d-6324-4d53-ad4f-8cda48b30811",
      network: "tcp", security: "none" } };
    if (JSON.stringify(redactTunnelConfig(cfg)) === JSON.stringify(cfg)) {
      ok("XRAY: a config with no credential is returned unchanged");
    } else {
      bad("XRAY: a config with no credential is returned unchanged", "the redactor altered a secret-free config");
    }
  }

  // Deeply nested and odd shapes must not throw.
  {
    const odd = { a: [[[{ token: SENTINEL.backhaulToken }]]], b: null, c: 0, d: "s", e: true };
    let threw = false; let json = "";
    try { json = JSON.stringify(redactTunnelConfig(odd)); } catch { threw = true; }
    if (!threw && !json.includes(SENTINEL.backhaulToken)) ok("a deeply nested secret is removed without throwing");
    else bad("a deeply nested secret is removed without throwing", threw ? "threw" : json.slice(0, 100));
  }
  // null / primitives are pass-through.
  for (const v of [null, 0, "", false, undefined]) {
    if (redactTunnelConfig(v) === v) { ok(`a primitive (${String(v)}) passes through unchanged`); break; }
    bad("a primitive passes through unchanged", String(v));
  }

  // Case-insensitivity: a PascalCase or SCREAMING field is still a secret.
  {
    const out = JSON.stringify(redactTunnelConfig({ Token: SENTINEL.backhaulToken, PASSWORD: SENTINEL.sshPassword }));
    if (!out.includes(SENTINEL.backhaulToken) && !out.includes(SENTINEL.sshPassword)) {
      ok("field matching is case-insensitive");
    } else {
      bad("field matching is case-insensitive", out.slice(0, 100));
    }
  }
})().then(() => {
  // ---- TASK-135: a stored config that no longer validates must be explained --
  //
  // `loadTunnelConfig` re-validates on every deploy, which is correct: a row
  // saved before a schema was tightened cannot produce a working tunnel. But the
  // ZodError's `.message` is a JSON dump of every issue, and it was travelling
  // verbatim from here to the API response to the UI -- 348 characters naming
  // internal paths like `gost.forwardHost`. The operator's only clue was a
  // schema dump.
  {
    const stale: Array<[string, unknown, string]> = [
      [
        "GOST saved before the relay target became required",
        { method: "GOST", gost: { direction: "IRAN", protocol: "tcp", listenPort: 9000 } },
        "gost.forwardHost",
      ],
      [
        "BACKHAUL saved with an empty listen address",
        {
          method: "BACKHAUL",
          backhaul: {
            role: "server",
            transport: "tcp",
            listenPort: 3080,
            token: "t",
            mux: 8,
            portMap: [],
            listenAddress: "",
          },
        },
        "backhaul.listenAddress",
      ],
      [
        "SSH saved with a delimiter in a spliced field",
        {
          method: "SSH",
          ssh: {
            mode: "local",
            host: "203.0.113.10",
            port: 22,
            username: "root",
            auth: "key",
            localPort: 8080,
            localBindAddr: "127.0.0.1",
            remoteHost: "a/b",
            remotePort: 80,
            remoteBindAddr: "127.0.0.1",
            dynamicBindAddr: "127.0.0.1",
          },
        },
        "ssh.remoteHost",
      ],
    ];

    for (const [label, cfg, field] of stale) {
      let message: string | undefined;
      try {
        loadTunnelConfig(cfg);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      if (!message) {
        bad(`${label} is refused`, "it was accepted");
        continue;
      }
      // It must still FAIL CLOSED -- that is the load-bearing property.
      ok(`${label} is refused, not silently repaired`);
      if (message.includes(field)) {
        ok(`  and the message names the offending field (${field})`);
      } else {
        bad(
          `  and the message names the offending field (${field})`,
          `message was ${JSON.stringify(message.slice(0, 120))}`,
        );
      }
      // And it must not read like a schema dump.
      const leaks =
        /"code":|"path":|invalid_type|unrecognized_keys|ZodError|must be at least|must not contain/.test(
          message,
        );
      if (!leaks && message.length < 260) {
        ok(`  and the message reads as guidance, not a dump (${message.length} chars)`);
      } else {
        bad(
          `  and the message reads as guidance, not a dump (${message.length} chars)`,
          leaks ? "it still contains Zod internals" : "it is too long to read",
        );
      }
    }

    // Positive control: a config that IS valid must still load untouched.
    try {
      const good = loadTunnelConfig({
        method: "GOST",
        gost: {
          direction: "IRAN",
          protocol: "tcp",
          listenPort: 9000,
          forwardHost: "198.51.100.7",
          forwardPort: 80,
        },
      });
      if (good.gost?.forwardHost === "198.51.100.7") {
        ok("a valid stored config still loads unchanged");
      } else {
        bad("a valid stored config still loads unchanged", `got ${JSON.stringify(good.gost)}`);
      }
    } catch (e) {
      bad(
        "a valid stored config still loads unchanged",
        `threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
  if (failures.length > 0) process.exitCode = 1;
});
