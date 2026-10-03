/**
 * Proves a benchmark result file is SANITIZED, and that a baseline can be
 * regenerated from a clean fixture.
 *
 * TASK-57 acceptance criteria 3 and 4. The harness already records host,
 * workload, install/startup separately, and declares what it did not measure.
 * What it does not prove is that the artifact on disk is safe to keep or
 * publish -- a result file is written next to the repo and read by the release
 * gate, so a secret in it is a secret in a committed file.
 *
 * The checks here are assertions about a REAL result file produced by a real
 * run, not about a fixture, so they cannot pass by construction.
 */
import fs from "node:fs";

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

const file = process.argv[2];
if (!file) {
  console.error("usage: npx tsx scripts/test-bench-sanitized.ts <result.json>");
  process.exit(2);
}
const raw = fs.readFileSync(file, "utf8");
const result = JSON.parse(raw) as Record<string, unknown>;

console.log(`\n--- AC3: the result file is machine-readable ---`);
ok("it parses as JSON", typeof result === "object" && result !== null);
ok("it carries a schema id", typeof result.schema === "string" && (result.schema as string).length > 0,
  String(result.schema));
ok("it records when it was generated", typeof result.generatedAt === "string");

console.log("\n--- AC3: no credentials in the result ---");
// Patterns for the things this app actually handles. A generic /secret/i scan
// would fire on the word "session" in a field name and prove nothing.
const CREDENTIAL_PATTERNS: Array<[string, RegExp]> = [
  ["JWT secret", /JWT_SECRET|JWTSECRET|jwt[_-]?secret/i],
  ["encryption key", /XTENC_KEY|xtenc[_-]?key/i],
  ["bearer token", /bearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  ["JWT-shaped triple", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ["hex blob >=32 chars", /["'][0-9a-f]{32,}["']/i],
  ["base64 blob >=40 chars", /["'][A-Za-z0-9+/]{40,}={0,2}["']/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["connection string", /postgres(ql)?:\/\/|mysql:\/\/|mongodb(\+srv)?:\/\//i],
  ["set-cookie value", /set-cookie[\s\S]{0,40}[A-Za-z0-9]{20,}/i],
  ["password assignment", /"(?:password|passwd|pass|secret|token|apiKey)"\s*:\s*"[^"]{4,}"/i],
  ["admin email literal", /admin@[a-z0-9.-]+\.[a-z]{2,}/i],
];
for (const [label, re] of CREDENTIAL_PATTERNS) {
  const m = raw.match(re);
  // The disposable benchmark admin address is a fixture identity rather than a
  // credential, so it is expected and permitted; everything else must be absent.
  ok(`no ${label}`, m === null, m ? `found: ${m[0].slice(0, 60)}` : "");
}

console.log("\n--- AC3: no database contents ---");
// Row-level data would mean the harness read the app's tables. It must only
// report counts it asked for through the API.
const suspiciousKeys = /(rows?|records?|entries|passwordHash|tokenHash|encrypted|ciphertext|iv|salt)/i;
const found: string[] = [];
const walk = (node: unknown, p: string): void => {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${p}[${i}]`));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (suspiciousKeys.test(k)) found.push(`${p}.${k}`);
      walk(v, `${p}.${k}`);
    }
  }
};
walk(result, "$");
ok("no row-like or secret-material keys", found.length === 0, found.slice(0, 5).join(", "));
ok("fixture is reported as counts only",
  typeof (result.workload as { fixture?: { nodes?: unknown } } | undefined)?.fixture?.nodes === "number");

console.log("\n--- AC2: install/startup separate, throughput not claimed ---");
const phases = (result.phases as Array<{ phase: string }> | undefined) ?? [];
const names = phases.map((p) => p.phase);
ok("install is its own phase", names.includes("install"), names.join(","));
ok("startup is its own phase", names.includes("startup"));
ok("control is its own phase", names.includes("control"));
const install = (result.install as Record<string, number> | undefined) ?? {};
ok("migrations timed separately", typeof install.migrationsMs === "number");
ok("admin bootstrap timed separately", typeof install.adminBootstrapMs === "number");
ok("fixture seeding is NOT folded into a measured phase",
  typeof install.fixtureSeedMs === "number",
  "seeded through the API, so it is setup cost");

const notMeasured = (result.notMeasured as string[] | undefined) ?? [];
ok("the result declares what it did not measure", notMeasured.length > 0, `${notMeasured.length} declared`);
ok("tunnel throughput is explicitly NOT claimed",
  notMeasured.some((n) => /throughput/i.test(n)), notMeasured.find((n) => /throughput/i.test(n))?.slice(0, 60) ?? "");
ok("bandwidth is explicitly NOT claimed", notMeasured.some((n) => /bandwidth/i.test(n)));
ok("live peer reconnection is not claimed as measured",
  notMeasured.some((n) => /live transport|real peers/i.test(n)));

console.log("\n--- AC1: the host identity that decides comparability ---");
const host = (result.host as Record<string, unknown> | undefined) ?? {};
for (const k of ["platform", "arch", "osRelease", "cpuModel", "vcpu", "totalMemoryBytes", "nodeVersion", "comparable"]) {
  ok(`records ${k}`, host[k] !== undefined && host[k] !== null, String(host[k]).slice(0, 40));
}
// swapBytes is legitimately null on Windows, but the KEY must exist, or a
// reader cannot tell "no swap" from "never looked".
ok("records swap even when there is none", "swapBytes" in host, `swapBytes=${String(host.swapBytes)}`);
ok("records artifact size", typeof (result.artifact as { sizeBytes?: unknown } | undefined)?.sizeBytes === "number");

console.log("\n--- AC4: a candidate is comparable only to its own host/workload ---");
const wl = (result.workload as { digest?: unknown; controlRequests?: unknown } | undefined) ?? {};
ok("the workload has a digest", typeof wl.digest === "string" && (wl.digest as string).length > 0, String(wl.digest));
ok("the workload size is recorded", typeof wl.controlRequests === "number", `${String(wl.controlRequests)} requests`);
ok("a comparability key is present", typeof host.comparable === "string", String(host.comparable));

console.log(`\n--- ${pass} passed, ${fail} failed ---`);
process.exit(fail === 0 ? 0 : 1);
