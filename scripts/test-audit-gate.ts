// Adversarial test for the waiver logic in scripts/audit-gate.sh.
//
// A waiver gate is only worth having if it can still FAIL, so this proves the
// decision is correct for four synthetic `npm audit --json` payloads:
//
//   1. the real dev-only braces chain  -> WAIVED (exit 0)
//   2. an unrelated NEW high advisory   -> FAIL  (exit 1)
//   3. a clean tree                     -> PASS  (exit 0)
//   4. a CRITICAL advisory              -> FAIL  (exit 1), never waivable
//
// IMPORTANT: this exercises the MATCHER, not the shell plumbing. It extracts the
// JavaScript the gate pipes its audit JSON into and runs it directly against each
// payload. Stubbing `npm` on PATH was tried first and is a trap on Windows/MSYS:
// a native temp path never resolves inside a bash PATH, so the stub silently never
// runs and the REAL npm answers instead -- a test that appears to exercise the
// gate while proving nothing about it.
//
// Production auditing is verified separately by running scripts/audit-gate.sh
// against the real tree (CI runs it on every push). This file is what proves the
// waiver cannot be silently widened.

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const WAIVED_GHSAS = "GHSA-vfj7-8cjw-p6xm";

const gate = readFileSync("scripts/audit-gate.sh", "utf8");

// Pull the embedded JS matcher out of the shell script so the thing under test is
// the SAME code CI runs, not a copy that can drift.
const open = gate.indexOf("node -e '");
if (open === -1) throw new Error("could not find the embedded matcher in scripts/audit-gate.sh");
const start = gate.indexOf("'", open) + 1;
const end = gate.indexOf("\n'\n", start);
if (end === -1) throw new Error("could not find the end of the embedded matcher");
const js = gate.slice(start, end).replace(/\\\$\{/g, "${").replace(/\\\\/g, "\\");

const advisory = (ghsa: string) => ({
  source: 1, name: "x", severity: "high", title: "t",
  url: `https://github.com/advisories/${ghsa}`, range: "<=1.0.0",
});

const BRACES_CHAIN = {
  "@next/eslint-plugin-next": { name: "@next/eslint-plugin-next", severity: "high", via: ["fast-glob"], range: "*", fixAvailable: false },
  braces: { name: "braces", severity: "high", via: [advisory("GHSA-vfj7-8cjw-p6xm")], range: "*", nodes: ["node_modules/braces"], fixAvailable: false },
  "eslint-config-next": { name: "eslint-config-next", severity: "high", via: ["@next/eslint-plugin-next"], range: "*", fixAvailable: false },
  "fast-glob": { name: "fast-glob", severity: "high", via: ["micromatch"], range: "*", fixAvailable: false },
  micromatch: { name: "micromatch", severity: "high", via: ["braces"], range: "*", fixAvailable: false },
};

const NEW_ADVISORY = {
  ...BRACES_CHAIN,
  express: { name: "express", severity: "high", via: [advisory("GHSA-TEST-new01")], range: "*", fixAvailable: true },
};

const cases = [
  { name: "the real dev-only braces chain is waived", payload: BRACES_CHAIN, want: 0, word: "AUDIT WAIVED" },
  { name: "an unrelated NEW high advisory fails", payload: NEW_ADVISORY, want: 1, word: "AUDIT FAIL" },
  // Each case's `payload` IS the vulnerabilities map, exactly as npm reports it.
  // The clean case must therefore be `{}`, not `{vulnerabilities:{}}` -- wrapping
  // that again yields `{vulnerabilities:{vulnerabilities:{}}}`, which the matcher
  // correctly reads as one advisory named "vulnerabilities" and refuses.
  { name: "a fully clean tree passes", payload: {}, want: 0, word: "AUDIT PASS" },
  { name: "a CRITICAL advisory is never waived", payload: { pkg: { name: "pkg", severity: "critical", via: [advisory("GHSA-vfj7-8cjw-p6xm")], range: "*" } }, want: 1, word: "AUDIT FAIL" },
];

let pass = 0, fail = 0;

for (const c of cases) {
  // Pass the waiver list through the REAL environment, exactly as the gate does.
  // Do NOT prepend a fake `const process = {...}`: that shadows the global, so
  // the matcher's own process.exit() throws and every case returns rc=1 --
  // which makes the two FAIL-expecting cases pass for entirely the wrong reason.
  const r = spawnSync(process.execPath, ["-e", js], {
    input: JSON.stringify({ vulnerabilities: c.payload }),
    encoding: "utf8",
    env: { ...process.env, WAIVED_GHSAS },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const rc = r.status;
  const ok = rc === c.want && out.includes(c.word);
  if (ok) { pass++; console.log(`  ok   ${c.name}`); }
  else {
    fail++;
    console.log(`  FAIL ${c.name}: rc=${rc} (want ${c.want}), "${c.word}" ${out.includes(c.word) ? "seen" : "MISSING"}`);
    console.log(`       ${out.trim().split("\n").slice(0, 3).join(" | ").slice(0, 140)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) { console.log("RESULT: FAIL"); process.exit(1); }
console.log("RESULT: PASS");
