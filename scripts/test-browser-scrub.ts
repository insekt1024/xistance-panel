/**
 * The browser gate prints failing-suite output. `scrub()` is what stands between
 * a diagnostic log and a leaked credential, so it needs a test that actually
 * runs -- an unreferenced probe in `scripts/` proves nothing, because the
 * aggregate's orphan check only scans `test-*.ts|sh`.
 *
 * Two properties, and both matter:
 *   1. every secret SHAPE is removed (token, cookie, DB password, session,
 *      private-key body, AWS-style key);
 *   2. the request context SURVIVES. A scrubber that blanks everything passes
 *      (1) and destroys the only reason to read the log.
 */

import { scrub } from "./run-browser-gate.ts";

/** A realistic leak: what a failing browser suite could print. */
const leak = [
  "GET /en 200",
  "authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop",
  "cookie: xt_access=s%3Aabc.def.ghi; path=/",
  'DB URL: file:./data/app.db?password=hunter2secret',
  'set-cookie: session=deadbeef; HttpOnly',
  'PRIVATE KEY -----BEGIN RSA PRIVATE KEY----- MIIEow== -----END RSA PRIVATE KEY-----',
  "api_key: AKIAIOSFODNN7EXAMPLE",
].join("\n");

const out = scrub(leak);
const mustBeGone = ["eyJhbGciOiJIUzI1NiJ9", "s%3Aabc.def.ghi", "hunter2secret", "deadbeef", "AKIAIOSFODNN7EXAMPLE", "MIIEowIB"];
const problems = mustBeGone.filter((t) => out.includes(t));

console.log("--- scrubbed output ---");
console.log(out);
console.log("\n--- verdict ---");
if (problems.length > 0) {
  console.error("SECRETS SURVIVED SCRUBBING:", problems.join(", "));
  process.exit(1);
}
if (!out.includes("GET /en 200")) {
  console.error("scrub destroyed the diagnostic context (the request line)");
  process.exit(1);
}
console.log("SCRUB OK: every secret shape removed, request context preserved.");
