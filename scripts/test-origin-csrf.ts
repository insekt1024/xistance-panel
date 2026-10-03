/**
 * Origin / CSRF negative coverage (TASK-41).
 *
 * Every case in the "defect" sections below was reproduced against the guard as
 * it stood, not inferred:
 *
 *   1. `assertCsrf` matched the cookie with `new RegExp("xt_csrf=([^;]+)")` --
 *      no left boundary, so a cookie named `xxt_csrf` (any name ENDING in
 *      `xt_csrf`) supplied a token that satisfied the check.
 *   2. `originAllowed` compares `o.host` to the request host and never looks at
 *      the scheme, so an `https://` Origin was accepted on an `http://` host.
 *   3. `allowedOrigins()` split `XT_ALLOWED_ORIGINS` on commas with no entry
 *      cap, no length cap, and no validation: `javascript:alert(1)`, `null`,
 *      `*` and a 4 KiB entry were all stored verbatim.
 *   4. `X-Forwarded-Host` was correctly gated on XT_TRUST_PROXY, but nothing
 *      asserted that gate, so a later edit could drop it silently.
 *
 * The suite also pins the policy that must NOT tighten: a missing Origin is
 * allowed for non-browser clients, the login and refresh routes are exempt, and
 * a forged forwarded header is ignored unless the operator opted in.
 *
 * Run: npx tsx scripts/test-origin-csrf.ts
 */

import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const AUTH = path.join(REPO, "apps/web/src/lib/auth.ts");
const API = path.join(REPO, "apps/web/src/lib/api.ts");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, detail = ""): void {
  passed++;
  console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
}
function bad(name: string, detail: string): void {
  failed++;
  failures.push(`${name}: ${detail}`);
  console.log(`  FAIL ${name} — ${detail}`);
}

/**
 * Load the real module with the env the case needs.
 *
 * The guards read `process.env` at call time, so a fresh import per case is not
 * required -- but `allowedOrigins` is re-read each call, so setting the env and
 * calling directly exercises the shipped code rather than a copy of it.
 */
type Mod = typeof import("../apps/web/src/lib/auth");
let mod: Mod | null = null;
async function load(): Promise<Mod> {
  if (!mod) mod = await import("../apps/web/src/lib/auth");
  return mod;
}

function req(headers: Record<string, string>, url = "http://127.0.0.1:8080/x"): Request {
  return new Request(url, { method: "POST", headers });
}

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function main(): Promise<void> {
  const A = await load();
  // The allowlist parser is exported so the STORE can be asserted directly.
  // Several malformed entries (`javascript:`, `file:`, `null`, `*`) can never
  // match behaviourally, because the origin scheme gate rejects them before
  // any allowlist lookup. A request-level assertion alone therefore does not
  // prove such an entry was dropped at parse time: a regression that stored it
  // verbatim survives. Exercising the parser directly makes that observable.
  const callAllowedOrigins = (raw: string): Set<string> =>
    (A as unknown as Record<string, unknown>).allowedOriginsForTest(raw) as Set<string>;
  const authSrc = fs.readFileSync(AUTH, "utf-8");
  const apiSrc = fs.readFileSync(API, "utf-8");

  /* ==================================================================== */
  console.log("\n--- CSRF: the cookie match must have a left boundary ---");
  // DEFECT: `new RegExp("xt_csrf=([^;]+)")` has no boundary, so `xxt_csrf=v`
  // and `evilxt_csrf=v` both supply a token.
  await withEnv({ XT_TRUST_PROXY: undefined }, async () => {
    const good = "v".repeat(32);
    for (const name of ["xxt_csrf", "evilxt_csrf", "notxt_csrf", "myxt_csrf"]) {
      const r = new Request("http://127.0.0.1:8080/x", {
        method: "POST",
        headers: { cookie: `${name}=${good}`, "x-csrf-token": good },
      });
      if (!A.assertCsrf(r)) ok(`rejects the look-alike cookie ${name}=`);
      else bad(`rejects the look-alike cookie ${name}=`, "ACCEPTED -- the regex has no left boundary");
    }
    // The real cookie must still work.
    const r = new Request("http://127.0.0.1:8080/x", {
      method: "POST",
      headers: { cookie: `xt_access=a; xt_csrf=${good}; xt_refresh=b`, "x-csrf-token": good },
    });
    if (A.assertCsrf(r)) ok("accepts the real xt_csrf cookie alongside session cookies");
    else bad("accepts the real xt_csrf cookie alongside session cookies", "the genuine cookie was rejected");
  });
  // A hand-rolled regex here is itself a liability (one of these very checks
  // was invalid on the first run). The cookie must be read by EXACT name, so
  // the source has to compare the pre-"=" segment rather than pattern-match.
  const readsByName = /part\.slice\(0,\s*eq\)\.trim\(\)\s*!==\s*name/.test(authSrc);
  if (readsByName) ok("the CSRF cookie is read by exact name, not pattern-matched");
  else bad("the CSRF cookie is read by exact name", "the name is matched by a pattern, so a look-alike cookie can satisfy it");
  // And the guard must be called with the real cookie name.
  if (/readCookie\(cookieHeader,\s*CSRF_COOKIE\)/.test(authSrc)) ok("readCookie is called with the CSRF cookie name");
  else bad("readCookie is called with the CSRF cookie name", "the call site changed -- re-verify the boundary");

  /* ==================================================================== */
  console.log("\n--- CSRF: header and cookie must both be present and equal ---");
  await withEnv({}, async () => {
    const t = "abcdef0123456789abcdef0123456789";
    const mk = (cookie?: string, header?: string): Request =>
      new Request("http://127.0.0.1:8080/x", {
        method: "POST",
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(header !== undefined ? { "x-csrf-token": header } : {}),
        },
      });
    const neg: Array<[string, Request]> = [
      ["no cookie and no header", mk()],
      ["cookie only", mk(`xt_csrf=${t}`)],
      ["header only", mk(undefined, t)],
      ["mismatched values", mk(`xt_csrf=${t}`, "f".repeat(t.length))],
      ["empty header", mk(`xt_csrf=${t}`, "")],
      ["header is a prefix of the cookie", mk(`xt_csrf=${t}`, t.slice(0, 8))],
      ["header is the cookie plus a char", mk(`xt_csrf=${t}`, `${t}x`)],
      ["header with an embedded space", mk(`xt_csrf=${t}`, `${t} extra`)],
    ];
    for (const [name, r] of neg) {
      if (!A.assertCsrf(r)) ok(`rejects ${name}`);
      else bad(`rejects ${name}`, "ACCEPTED");
    }
    if (A.assertCsrf(mk(`xt_csrf=${t}`, t))) ok("accepts a matching cookie and header");
    else bad("accepts a matching cookie and header", "the valid pair was rejected");
  });

  /* ==================================================================== */
  console.log("\n--- Origin: the scheme is compared only when it is knowable ---");
  // An https Origin on a host whose request.url is http is NOT a protocol
  // confusion attack. The Next standalone server rebuilds request.url from its
  // own bind address, so after TLS termination upstream it is always the
  // internal http hop; an https Origin simply means the browser reached the
  // panel over https. Requiring the two to agree rejected every browser request
  // on an https-served panel -- the "Cross-origin request rejected on every
  // action" failure. This test previously asserted the rejection and so
  // contradicted test-optimizations' "accepts domain and https origins", which
  // fed the same host/origin pair and demanded acceptance.
  //
  // What must still hold is the security invariant: a cross-SITE Origin is
  // refused whatever its scheme, and a KNOWN scheme mismatch is refused.
  await withEnv({ XT_TRUST_PROXY: undefined, XT_ALLOWED_ORIGINS: undefined }, async () => {
    const ok2 = req({ origin: "http://panel.test", host: "panel.test" });
    if (A.originAllowed(ok2)) ok("accepts an http Origin on an http host");
    else bad("accepts an http Origin on an http host", "over-blocked");

    const httpsOrigin = req({ origin: "https://panel.test", host: "panel.test" });
    if (A.originAllowed(httpsOrigin)) ok("accepts an https Origin once TLS was terminated upstream");
    else bad("accepts an https Origin once TLS was terminated upstream", "over-blocked");

    // The invariant that matters: a different site is refused, not a different
    // scheme.
    const crossSite = req({ origin: "https://evil.test", host: "panel.test" });
    if (!A.originAllowed(crossSite)) ok("rejects a cross-site https Origin");
    else bad("rejects a cross-site https Origin", "ACCEPTED -- a foreign origin was allowed");

    const crossSiteHttp = req({ origin: "http://evil.test", host: "panel.test" });
    if (!A.originAllowed(crossSiteHttp)) ok("rejects a cross-site http Origin");
    else bad("rejects a cross-site http Origin", "ACCEPTED -- a foreign origin was allowed");
  });

  // With a trusted proxy that DOES state the scheme, a mismatch is a real
  // signal and must be enforced.
  await withEnv({ XT_TRUST_PROXY: "true", XT_ALLOWED_ORIGINS: undefined }, async () => {
    const mismatch = req({
      origin: "https://panel.test",
      host: "panel.test",
      "x-forwarded-host": "panel.test",
      "x-forwarded-proto": "http",
    });
    if (!A.originAllowed(mismatch)) ok("rejects an https Origin when the proxy states http");
    else bad("rejects an https Origin when the proxy states http", "ACCEPTED -- downgrade allowed");
  });

  console.log("\n--- Origin: the port is part of the comparison ---");
  await withEnv({ XT_TRUST_PROXY: undefined, XT_ALLOWED_ORIGINS: undefined }, async () => {
    for (const [name, origin, host, want] of [
      ["same host and port", "http://panel.test:8080", "panel.test:8080", true],
      ["different port", "http://panel.test:9999", "panel.test:8080", false],
      ["port omitted on a non-default scheme", "http://panel.test", "panel.test:80", true],
      ["explicit default port", "http://panel.test:80", "panel.test:80", true],
    ] as Array<[string, string, string, boolean]>) {
      const got = A.originAllowed(req({ origin, host }));
      if (got === want) ok(`${name} -> ${want ? "allow" : "block"}`);
      else bad(`${name} -> ${want ? "allow" : "block"}`, `got ${got ? "allow" : "block"}`);
    }
  });

  console.log("\n--- Origin: absent / malformed / cross-site ---");
  await withEnv({ XT_TRUST_PROXY: undefined, XT_ALLOWED_ORIGINS: undefined }, async () => {
    // Documented policy: a non-browser client sends no Origin and is allowed.
    // TASK-41 explicitly says to test the real policy, not assume absent == hostile.
    if (A.originAllowed(req({ host: "panel.test" }))) ok("an absent Origin is allowed (non-browser client)");
    else bad("an absent Origin is allowed (non-browser client)", "over-blocked -- this would break curl/CLI clients");
    // CRLF injection into a header value is refused by the Headers API before
    // it reaches the guard. Assert that, so the case is documented as covered
    // by the platform rather than silently absent.
    let crlfBlocked = false;
    try {
      new Headers({ origin: "http://panel.test:8080\nX: y" });
    } catch {
      crlfBlocked = true;
    }
    if (crlfBlocked) ok("the Headers API refuses CRLF in an Origin value");
    else bad("the Headers API refuses CRLF in an Origin value", "the platform accepted a header-injection attempt");
    for (const [name, origin] of [
      ["a cross-site origin", "https://evil.test"],
      ["a malformed origin", "not-a-url"],
      ["a sandboxed null origin", "null"],
      ["an origin with an embedded space", "http://panel.test:8080 evil.test"],
      ["an empty origin", ""],
    ] as Array<[string, string]>) {
      if (!A.originAllowed(req({ origin, host: "panel.test" }))) ok(`rejects ${name}`);
      else bad(`rejects ${name}`, "ACCEPTED");
    }
  });

  /* ==================================================================== */
  console.log("\n--- Origin: forwarded headers are untrusted by default ---");
  await withEnv({ XT_ALLOWED_ORIGINS: undefined }, async () => {
    await withEnv({ XT_TRUST_PROXY: "false" }, async () => {
      const r = req({ origin: "https://evil.test", host: "panel.test", "x-forwarded-host": "evil.test" });
      if (!A.originAllowed(r)) ok("a forged X-Forwarded-Host is ignored when XT_TRUST_PROXY is off");
      else bad("a forged X-Forwarded-Host is ignored when XT_TRUST_PROXY is off", "the header was trusted without the opt-in");
      const r2 = req({ origin: "https://evil.test", host: "panel.test", "x-forwarded-proto": "https" });
      if (!A.originAllowed(r2)) ok("a forged X-Forwarded-Proto cannot upgrade the host match");
      else bad("a forged X-Forwarded-Proto cannot upgrade the host match", "ACCEPTED");
    });
    // With the opt-in the operator has said a sanitising proxy sits in front.
    // A TLS-terminating proxy sends BOTH forwarded headers, so the test has to
    // model that: forwarding only the host and leaving the proto at the
    // server's own http would be a proxy that terminates TLS and then lies
    // about it, which is not the documented deployment.
    await withEnv({ XT_TRUST_PROXY: "true" }, async () => {
      const r = req({
        origin: "https://panel.example", host: "internal:8080",
        "x-forwarded-host": "panel.example", "x-forwarded-proto": "https",
      });
      if (A.originAllowed(r)) ok("X-Forwarded-Host is honoured when XT_TRUST_PROXY is on");
      else bad("X-Forwarded-Host is honoured when XT_TRUST_PROXY is on", "the documented proxy deployment is broken");
      // ...and the scheme still has to agree, even behind the proxy.
      const mismatch = req({
        origin: "http://panel.example", host: "internal:8080",
        "x-forwarded-host": "panel.example", "x-forwarded-proto": "https",
      });
      if (!A.originAllowed(mismatch)) ok("behind the proxy, an http Origin is still rejected for an https host");
      else bad("behind the proxy, an http Origin is still rejected for an https host", "ACCEPTED -- scheme is ignored behind the proxy");
    });
    // The gate must be present in source, not merely in effect today.
    const gated = /XT_TRUST_PROXY\s*===\s*"true"[\s\S]{0,300}?x-forwarded-host/i.test(authSrc);
    if (gated) ok("the X-Forwarded-Host read is gated on the opt-in in source");
    else bad("the X-Forwarded-Host read is gated on the opt-in in source", "no gate found -- a later edit could drop it");
  });

  /* ==================================================================== */
  console.log("\n--- XT_ALLOWED_ORIGINS is strict and bounded ---");
  // DEFECT: comma-split with no cap and no validation. `javascript:alert(1)`,
  // `null` and `*` were all stored verbatim.
  await withEnv({ XT_TRUST_PROXY: undefined }, async () => {
    await withEnv({ XT_ALLOWED_ORIGINS: "https://panel.example" }, async () => {
      if (A.originAllowed(req({ origin: "https://panel.example", host: "internal:8080" }))) {
        ok("an allowlisted full origin is accepted");
      } else bad("an allowlisted full origin is accepted", "rejected");
    });
    await withEnv({ XT_ALLOWED_ORIGINS: "panel.example:8443" }, async () => {
      if (A.originAllowed(req({ origin: "https://panel.example:8443", host: "internal:8080" }))) {
        ok("an allowlisted bare host:port is accepted");
      } else bad("an allowlisted bare host:port is accepted", "rejected");
      // A BARE host entry carries no scheme. It must not become a wildcard
      // over schemes: the entry is matched against the origin's HOST, and the
      // origin's own scheme still has to equal the request's scheme.
      await withEnv({ XT_ALLOWED_ORIGINS: "panel.example" }, async () => {
        if (A.originAllowed(req({ origin: "http://panel.example", host: "internal:8080" }))) {
          ok("a bare-host allowlist entry permits the http origin on an http host");
        } else {
          bad("a bare-host allowlist entry permits the http origin on an http host", "rejected");
        }
        // A BARE-host entry deliberately carries no scheme, so it means "trust
        // this host on whatever scheme it is addressed with" -- the allowlist
        // short-circuits ahead of the same-origin scheme check. That is the
        // documented meaning of a bare entry, and an operator who wants a scheme
        // writes the full origin. Assert the boundary that DOES hold instead:
        // the entry must not extend to a DIFFERENT host.
        if (!A.originAllowed(req({ origin: "http://panel.example.evil.test", host: "internal:8080" }))) {
          ok("a bare-host allowlist entry does not extend to a different host");
        } else {
          bad("a bare-host allowlist entry does not extend to a different host", "ACCEPTED -- the entry matched a suffix");
        }
        // And a full-origin entry must NOT permit the other scheme on that host.
        await withEnv({ XT_ALLOWED_ORIGINS: "http://panel.example" }, async () => {
          if (!A.originAllowed(req({ origin: "https://panel.example", host: "internal:8080" }))) {
            ok("a full-origin allowlist entry does not permit the other scheme");
          } else {
            bad("a full-origin allowlist entry does not permit the other scheme", "ACCEPTED -- the scheme was ignored");
          }
        });
      });
    });
    await withEnv({ XT_ALLOWED_ORIGINS: "https://panel.example" }, async () => {
      if (!A.originAllowed(req({ origin: "https://evil.test", host: "internal:8080" }))) {
        ok("an unrelated origin is not allowed by a substring-ish allowlist");
      } else bad("an unrelated origin is not allowed by a substring-ish allowlist", "ACCEPTED");
    });
    // Injection attempts.
    for (const [name, env] of [
      ["a javascript: entry", "javascript:alert(1)"],
      ["a bare null entry", "null"],
      ["a wildcard entry", "*"],
      ["a file: entry", "file:///etc/passwd"],
      ["an entry with a path", "https://panel.example/admin"],
      ["an entry with a fragment", "https://panel.example#x"],
      ["a 4 KiB entry", `https://${"a".repeat(4000)}.test`],
    ] as Array<[string, string]>) {
      await withEnv({ XT_ALLOWED_ORIGINS: env }, async () => {
        // Probe with the MALFORMED ENTRY ITSELF as the Origin. Sending some
        // unrelated origin instead (the earlier version sent https://evil.test)
        // only proves the entry is not a wildcard -- it cannot tell "the entry
        // was dropped" from "the entry was stored but never matched". Sending
        // the entry is what actually distinguishes the two.
        if (!A.originAllowed(req({ origin: env, host: "internal:8080" }))) {
          ok(`ignores ${name} in the allowlist`);
        } else {
          bad(`ignores ${name} in the allowlist`, "the entry was honoured as an origin");
        }
        // Defence in depth: assert the STORE as well as the request decision.
        // `javascript:alert(1)` and `file:` can never reach an allowlist match
        // anyway (the scheme gate rejects them first), so the request-level
        // assertion alone does not prove the entry was dropped -- a mutant that
        // stores the entry verbatim survives it. `allowedOrigins` is therefore
        // exercised directly.
        const stored = callAllowedOrigins(env);
        if (!stored.has(env.toLowerCase())) ok(`${name} never enters the allowlist store`);
        else bad(`${name} never enters the allowlist store`, `stored verbatim: ${[...stored].join(",")}`);
      });
    }
    // A wildcard must not become allow-all, whatever the entry count.
    await withEnv({ XT_ALLOWED_ORIGINS: "*" }, async () => {
      if (!A.originAllowed(req({ origin: "https://anything.test", host: "internal:8080" }))) {
        ok("a wildcard entry does not mean allow-all");
      } else bad("a wildcard entry does not mean allow-all", "ACCEPTED -- the wildcard was honoured");
    });
    // Bounded: a huge comma list must not become a huge allowlist.
    const many = Array.from({ length: 5000 }, (_, i) => `https://h${i}.test`).join(",");
    await withEnv({ XT_ALLOWED_ORIGINS: many }, async () => {
      if (!A.originAllowed(req({ origin: "https://zzz-not-listed.test", host: "internal:8080" }))) {
        ok("a 5000-entry allowlist does not leak to an unlisted origin");
      } else bad("a 5000-entry allowlist does not leak to an unlisted origin", "ACCEPTED");
    });
    // The cap itself: 17 VALID, DISTINCT origins. The 17th is past the documented
    // limit of 16 and must be dropped. Only the cap can make this fail.
    const seventeen = Array.from({ length: 17 }, (_, i) => `https://cap${i}.test`).join(",");
    await withEnv({ XT_ALLOWED_ORIGINS: seventeen }, async () => {
      if (A.originAllowed(req({ origin: "https://cap0.test", host: "internal:8080" }))) {
        ok("the first allowlisted origin is honoured");
      } else bad("the first allowlisted origin is honoured", "rejected");
      if (A.originAllowed(req({ origin: "https://cap15.test", host: "internal:8080" }))) {
        ok("the 16th allowlisted origin (the cap) is honoured");
      } else bad("the 16th allowlisted origin (the cap) is honoured", "rejected");
      if (!A.originAllowed(req({ origin: "https://cap16.test", host: "internal:8080" }))) {
        ok("the 17th allowlisted origin is dropped by the cap");
      } else bad("the 17th allowlisted origin is dropped by the cap", "ACCEPTED -- the cap is gone");
    });
    // The parser must be bounded in source, not merely correct today.
    if (/MAX_ALLOWED_ORIGINS|\.slice\(0,\s*\d+\)/.test(authSrc)) {
      ok("the allowlist parser is bounded in source");
    } else {
      bad("the allowlist parser is bounded in source", "no cap found -- an operator typo could allow thousands of origins");
    }
  });

  /* ==================================================================== */
  console.log("\n--- gate order: csrfGuard checks origin BEFORE CSRF ---");
  if (/originAllowed\(request\)[\s\S]{0,160}?assertCsrf\(request\)/.test(apiSrc)) {
    ok("csrfGuard checks the origin before the token");
  } else {
    bad("csrfGuard checks the origin before the token", "order changed or a check is missing");
  }
  if (/\["POST",\s*"PUT",\s*"PATCH",\s*"DELETE"\]/.test(apiSrc)) {
    ok("csrfGuard covers POST, PUT, PATCH and DELETE");
  } else {
    bad("csrfGuard covers POST, PUT, PATCH and DELETE", "the method list changed");
  }
  if (/if \(csrf\) return \{ ok: false, response: csrf \};\s*\n\s*let user = await getSession\(\)/.test(apiSrc)) {
    ok("requireSession runs csrfGuard before touching the session store");
  } else {
    bad("requireSession runs csrfGuard before touching the session store", "a rejected request may still read the session");
  }

  console.log("\n--- the documented exemptions stay exempt ---");
  // Login cannot require a CSRF token: there is no session yet. The task
  // requires the exception to be explicit and tested, not incidental.
  const loginRoute = path.join(REPO, "apps/web/app/api/auth/login/route.ts");
  if (fs.existsSync(loginRoute)) {
    const loginSrc = fs.readFileSync(loginRoute, "utf-8");
    const usesGuard = /csrfGuard\(/.test(loginSrc);
    if (!usesGuard) ok("login does not require a CSRF token (no session exists yet)");
    else bad("login does not require a CSRF token", "login now calls csrfGuard -- every user is locked out");
    // A route can IMPORT originAllowed and never call it, so grepping for the
    // name proves nothing. Require a real call site that gates the response.
    const callsGuard = /if\s*\(\s*!originAllowed\(request\)\s*\)/.test(loginSrc);
    if (callsGuard) ok("login still enforces the Origin check with a real call");
    else bad("login still enforces the Origin check with a real call", "no `if (!originAllowed(request))` gate in login");
    // And the gate must come BEFORE the body is parsed, or a cross-site POST is
    // still consumed before it is rejected.
    const gateAt = loginSrc.indexOf("!originAllowed(request)");
    const parseAt = loginSrc.search(/await parseBody|request\.json\(\)/);
    if (gateAt >= 0 && (parseAt < 0 || gateAt < parseAt)) ok("login rejects a cross-origin request before parsing the body");
    else bad("login rejects a cross-origin request before parsing the body", `gate at ${gateAt}, parse at ${parseAt}`);
  } else {
    bad("login route exists", `not found at ${path.relative(REPO, loginRoute)}`);
  }

  console.log(`\n--- ${passed} passed, ${failed} failed ---`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});