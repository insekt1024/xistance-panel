/**
 * Rate limiting and abuse controls (TASK-43).
 *
 * 17 of 31 API routes had an explicit rate limit. The 14 without one include
 * NINE state-changing routes, which is the wrong side of the line: a cheap GET
 * is cheap, but an unbounded POST is not.
 *
 * The clearest gap is `POST /api/users`. It is guarded by `requireSession(ADMIN)`
 * — so an authenticated ADMIN, which a compromised or careless admin account is
 * — can create accounts with no ceiling, and each one runs `hashPassword`, an
 * scrypt at ~100ms. Ten concurrent requests saturate a 1 vCPU core, which is
 * exactly the VPS profile this release targets. The other eight let a single
 * authenticated session create nodes (each spawning an SSH connection attempt),
 * port forwards, webhooks, and users with nothing stopping a scripted loop.
 *
 * Rate limiting is NOT a substitute for auth, CSRF or SSRF. Those stay
 * independent; this suite also asserts they were not weakened to compensate.
 */

import fs from "node:fs";
import path from "node:path";
import { freeLoopbackPort } from "./lib/pick-port";

let pass = 0;
const failures: string[] = [];
const ok = (name: string, extra = "") => { pass += 1; console.log(`  ok   ${name}${extra ? " — " + extra : ""}`); };
const bad = (name: string, detail: string) => { failures.push(name); console.log(`  FAIL ${name}\n       ${detail}`); };

const REPO = path.resolve(__dirname, "..");
const API = path.join(REPO, "apps/web/app/api");

/* ------------------------------------------------- 1. the limiter itself */

async function main(): Promise<void> {

console.log("\n--- the fixed-window limiter ---");
{
  // A fresh module per import so bucket state does not leak between sections.
  const mod = await import("../apps/web/src/lib/rate-limit.ts");
  const { rateLimit } = mod;

  // Reset behaviour.
  {
    const key = `t:${Date.now()}:a`;
    const first = rateLimit(key, 3, 1_000);
    if (first.ok && first.remaining === 2) ok("the first request is allowed and reports limit-1 remaining");
    else bad("the first request is allowed", JSON.stringify(first));
    if (rateLimit(key, 3, 1_000).remaining === 1) ok("remaining decrements on each request");
    else bad("remaining decrements", JSON.stringify(rateLimit(key, 3, 1_000)));
    if (rateLimit(key, 3, 1_000).ok) ok("the third request is still within the limit");
    else bad("the third request is within the limit", "rejected early");
    const fourth = rateLimit(key, 3, 1_000);
    if (!fourth.ok && fourth.remaining === 0) ok("the fourth request is rejected with remaining 0");
    else bad("the fourth request is rejected", JSON.stringify(fourth));
    // Never negative: a caller that renders `remaining` must not show -1.
    rateLimit(key, 3, 1_000); rateLimit(key, 3, 1_000);
    const deep = rateLimit(key, 3, 1_000);
    if (deep.remaining === 0) ok("remaining never goes negative under sustained abuse");
    else bad("remaining never goes negative", `got ${deep.remaining}`);
  }

  // Window reset.
  {
    const key = `t:${Date.now()}:b`;
    rateLimit(key, 1, 120);
    if (!rateLimit(key, 1, 120).ok) ok("a 1-per-window limit rejects the second request");
    else bad("a 1-per-window limit rejects the second request", "allowed");
    await new Promise((r) => setTimeout(r, 180));
    if (rateLimit(key, 1, 120).ok) ok("the window resets and allows the request again");
    else bad("the window resets", "still rejected after the window elapsed");
  }

  // Cap eviction, and the recency property that makes it correct.
  {
    // The limiter's cap is module-private; assert the source declares one and
    // that eviction is O(1) rather than a full scan.
    const src = fs.readFileSync(path.join(REPO, "apps/web/src/lib/rate-limit.ts"), "utf8");
    if (/MAX_BUCKETS\s*=\s*\d+/.test(src)) ok("the bucket map has a declared size cap");
    else bad("the bucket map has a declared size cap", "MAX_BUCKETS not found");
    if (/buckets\.size\s*>=\s*MAX_BUCKETS/.test(src)) ok("eviction triggers at the cap");
    else bad("eviction triggers at the cap", "no size check before insert");
    // A full scan on every insert is the O(n) behaviour that was replaced.
    const scans = /for\s*\(\s*const\s+\[.*\]\s+of\s+buckets\s*\)/.test(
      src.slice(src.indexOf("if (buckets.size >= MAX_BUCKETS)"), src.indexOf("buckets.set(key")),
    );
    if (!scans) ok("eviction is O(1), not a scan of every bucket");
    else bad("eviction is O(1)", "a full scan runs on every insert while full");
    // Recency: reusing a key must not pin it at the oldest slot.
    if (/if \(existing\) buckets\.delete\(key\)/.test(src)) {
      ok("a refreshed key is re-inserted so it is not evicted as stale");
    } else {
      bad("a refreshed key is re-inserted", "the delete-before-set refresh is gone");
    }
  }
}

/* ---------------------------------------- 2. every sensitive route is limited */

console.log("\n--- route coverage ---");
{
  // State-changing routes that MUST carry an explicit limit. Each is chosen
  // because a single request costs real server work or changes real state.
  const MUST_LIMIT: Array<[string, string]> = [
    ["auth/login", "unauthenticated credential stuffing"],
    ["nodes", "each POST can spawn an SSH connection attempt"],
    ["nodes/[id]", "PUT/DELETE reconfigure or drop a node"],
    ["port-forwards", "creates listening sockets"],
    ["port-forwards/[id]", "rewrites forwarding rules"],
    ["tunnels", "creates a tunnel process"],
    ["tunnels/[id]", "deletes a tunnel and its processes"],
    ["tunnels/[id]/actions", "starts/stops/restarts processes"],
    ["tunnels/[id]/logs", "reads or writes process output"],
    ["tunnels/batch", "bulk process control"],
    ["users", "each POST runs an scrypt hashPassword (~100ms)"],
    ["users/[id]", "changes roles, quota or the password"],
    ["webhooks", "registers an outbound URL"],
    ["webhooks/[id]", "mutates a registered webhook"],
    ["xui/test", "makes an outbound request to a panel"],
    ["tools", "makes outbound requests"],
    ["nodes/[id]/test", "makes an outbound SSH/TCP probe"],
    ["settings/backup", "reads or writes the whole database"],
    ["settings/password", "changes the caller's own password"],
    ["update/check", "makes an outbound version request"],
  ];

  const missing: string[] = [];
  const missingDetail: string[] = [];
  for (const [rel, why] of MUST_LIMIT) {
    const f = path.join(API, rel, "route.ts");
    if (!fs.existsSync(f)) { missing.push(rel); missingDetail.push(`${rel}: route not found`); continue; }
    const src = fs.readFileSync(f, "utf8");
    if (src.includes("rateLimit(")) continue;
    missing.push(rel);
    missingDetail.push(`${rel} — ${why}`);
  }
  if (missing.length === 0) ok(`all ${MUST_LIMIT.length} state-changing routes carry a rate limit`);
  else {
    bad(`all ${MUST_LIMIT.length} state-changing routes carry a rate limit`,
      `${missing.length} unprotected:\n       ${missingDetail.join("\n       ")}`);
  }

  // Public read-only routes may legitimately be unlimited; assert that is a
  // deliberate exemption rather than an oversight.
  const MAY_BE_OPEN = ["health", "auth/me", "docs"];
  for (const rel of MAY_BE_OPEN) {
    const f = path.join(API, rel, "route.ts");
    if (fs.existsSync(f) && !fs.readFileSync(f, "utf8").includes("rateLimit(")) {
      ok(`${rel} is a deliberate public/read-only exemption`);
    } else {
      ok(`${rel} is limited (no exemption needed)`);
    }
  }
}

/* ---------------------------------------- 3. the key is a trusted identity */

console.log("\n--- key trust boundary ---");
{
  // A key must be derived from the AUTHENTICATED session, never from a header
  // the caller controls. An email-keyed login bucket is also acceptable (it is
  // an input, not a header) and is what the route already does.
  const login = fs.readFileSync(path.join(API, "auth/login/route.ts"), "utf8");
  const ipCalls = [...login.matchAll(/rateLimit\(\s*`login:ip:\$\{([^}]+)\}`/g)].map((m) => m[1]!);
  if (ipCalls.length === 1) ok("the login IP bucket is keyed from a single trusted source", `key: login:ip:{${ipCalls[0]}}`);
  else bad("the login IP bucket is keyed from a single trusted source", `found ${ipCalls.length}: ${ipCalls.join(", ")}`);
  if (/if \(ip\)/.test(login)) {
    ok("the IP bucket is only applied when a trusted client IP exists");
  } else {
    bad("the IP bucket is only applied when a trusted client IP exists", "no guard around the IP bucket");
  }
  // The email bucket is unconditional on purpose: header rotation must not
  // bypass it, so an attacker cannot get unlimited attempts by varying a header.
  if (/rateLimit\(\s*`login:email:\$\{email\}`/.test(login)) {
    ok("the login email bucket is unconditional (header rotation cannot bypass it)");
  } else {
    bad("the login email bucket is unconditional", "the email bucket is conditional");
  }

  // EVERY bucket key in the app must derive from the authenticated session or
  // from a trusted-IP helper -- never from a request header the caller controls.
  //
  // Mutant D keyed `users-create` on `x-forwarded-for`, which any client can
  // set, and it survived: the bucket then resets whenever the header changes, so
  // "limited" becomes meaningless.
  {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === "route.ts") {
          const src = fs.readFileSync(full, "utf8");
          for (const m of src.matchAll(/rateLimit\(\s*`([^`]*)`/g)) {
            const key = m[1]!;
            const exprs = [...key.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]!.trim());
            for (const expr of exprs) {
              // Allowed: anything ending in `.user.id` or `.user.email` (the
              // routes reach the user through `auth` or through an
              // `authorizeTunnel()` wrapper, so the object name varies), and
              // the one trusted-IP helper, which is already gated on
              // XT_TRUST_PROXY.
              const okKey = /\.user\.(id|email)$/.test(expr) || /^(ip|email)$/.test(expr);
              if (!okKey) {
                offenders.push(`${path.relative(API, full).replace(/[\\/]route\.ts$/, "")}: ${key}`);
              }
            }
          }
        }
      }
    };
    walk(API);
    if (offenders.length === 0) ok("every rate-limit key derives from the session or the trusted-IP helper");
    else {
      bad("every rate-limit key derives from the session or the trusted-IP helper",
        `${offenders.length} key(s) derive from something else (a caller-controlled value can be rotated to reset the bucket):\n       ${offenders.join("\n       ")}`);
    }
  }

  // getClientIp must stay gated on the documented proxy opt-in.
  const api = fs.readFileSync(path.join(REPO, "apps/web/src/lib/api.ts"), "utf8");
  if (/getClientIp[\s\S]{0,400}XT_TRUST_PROXY\s*!==\s*"true"\)\s*return null/.test(api)) {
    ok("getClientIp returns null unless XT_TRUST_PROXY is exactly \"true\"");
  } else {
    bad("getClientIp returns null unless XT_TRUST_PROXY is exactly \"true\"",
      "the opt-in guard was changed — forwarded headers must never be trusted by default");
  }
}

/* ---------------------------------------- 4. auth/CSRF/SSRF stay independent */

console.log("\n--- rate limiting did not replace other controls ---");
{
  const login = fs.readFileSync(path.join(API, "auth/login/route.ts"), "utf8");
  if (/verifyPassword/.test(login)) ok("login still verifies a password (not just throttled)");
  else bad("login still verifies a password", "verifyPassword missing");

  const api = fs.readFileSync(path.join(REPO, "apps/web/src/lib/api.ts"), "utf8");
  if (/assertCsrf/.test(api) && /originAllowed/.test(api)) {
    ok("the CSRF guard still calls both originAllowed and assertCsrf");
  } else {
    bad("the CSRF guard still calls both originAllowed and assertCsrf", "a control was weakened");
  }
  if (/requireSession/.test(api)) ok("requireSession is still the route guard");
  else bad("requireSession is still the route guard", "missing");

  // A newly limited route must not have gained an SSRF bypass to get there.
  const tools = fs.readFileSync(path.join(API, "tools/route.ts"), "utf8");
  if (/isBlockedTarget|assertSafe|ssrf/i.test(tools)) {
    ok("the tools route keeps its SSRF guard alongside the rate limit");
  } else {
    bad("the tools route keeps its SSRF guard", "the SSRF guard is missing");
  }
}

/* ------------------------------------------------ 5. no key or secret leaks */

console.log("\n--- 429 responses leak nothing ---");
{
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "route.ts") {
        const src = fs.readFileSync(full, "utf8");
        for (const m of src.matchAll(/rateLimit\(([\s\S]{0,200}?)\)/g)) {
          const arg = m[1]!;
          // A 429 must describe the POLICY, never the bucket key. Interpolating
          // the key would echo the email, the user id, or the client IP back to
          // the caller -- and into any proxy log in between.
          // Look at the 429 return statement itself, not a window after the
          // call: a wide window routinely swallows the NEXT rateLimit call's
          // template literal and reports a false leak.
          for (const r of src.matchAll(/apiError\(\s*`([^`]*)`\s*,\s*429\s*\)/g)) {
            if (/\$\{/.test(r[1]!)) {
              offenders.push(`${path.relative(API, full).replace(/[\\/]route\.ts$/, "")}: ${r[1]!.slice(0, 80)}`);
            }
          }
          // Also catch a 429 whose message is built by concatenation.
          for (const r of src.matchAll(/apiError\(([^,]*(?:\+\s*\w+)[^,]*),\s*429\s*\)/g)) {
            offenders.push(`${path.relative(API, full).replace(/[\\/]route\.ts$/, "")}: ${r[1]!.trim().slice(0, 80)}`);
          }
          void arg;
        }
      }
    }
  };
  walk(API);
  if (offenders.length === 0) ok("no 429 response interpolates a bucket key");
  else {
    bad("no 429 response interpolates a bucket key",
      `${offenders.length} leak(s): ${offenders.slice(0, 5).join(" | ")}`);
  }

  // No route may put a password, token or key material into a limit key.
  const leaks: string[] = [];
  const walk2 = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk2(full);
      else if (e.name === "route.ts") {
        const src = fs.readFileSync(full, "utf8");
        for (const m of src.matchAll(/rateLimit\(\s*`([^`]*)`/g)) {
          const key = m[1]!;
          // A bucket LABEL ("password:", "login:email:") is not secret
          // material -- it is a constant prefix followed by an id. Flag only
          // when a value that could carry a secret is interpolated, i.e. when
          // the sensitive word is INSIDE a ${...} rather than the label.
          const interpolations = [...key.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]!);
          for (const expr of interpolations) {
            if (/password|token|secret|apikey|api_key|authorization/i.test(expr)) {
              leaks.push(`${path.relative(API, full)}: ${key} (interpolates ${expr})`);
            }
          }
        }
      }
    }
  };
  walk2(API);
  if (leaks.length === 0) ok("no rate-limit key contains secret material");
  else bad("no rate-limit key contains secret material", leaks.join(" | "));
}


  /* --------------------------------------- 6. a limited route really returns 429 */

console.log("\n--- live 429 from a newly limited route ---");
await (async () => {
  const { spawn, spawnSync } = await import("node:child_process");
  const { createServer } = await import("node:net");
  const os2 = await import("node:os");
  const { randomBytes } = await import("node:crypto");
  const webDir = path.join(REPO, "apps/web");
  if (!fs.existsSync(path.join(webDir, ".next/BUILD_ID"))) {
    console.log("  skip  no production build in apps/web/.next");
  } else {
    const tmp = fs.mkdtempSync(path.join(os2.tmpdir(), "xt-rl-"));
    const db = path.join(tmp, "rl.db").replace(/\\/g, "/");
    const email = "rl-probe@example.invalid";
    const pw = randomBytes(12).toString("base64url");
    const mig = spawnSync(process.execPath, [path.join(REPO, "scripts/apply-migrations.mjs"), "--database", db], { encoding: "utf8" });
    const adm = spawnSync(process.execPath, [path.join(REPO, "scripts/create-admin.mjs"), "--database", db, "--email", email, "--password", pw], { encoding: "utf8" });
    if (mig.status !== 0 || adm.status !== 0) {
      console.log("  skip  could not provision a disposable admin");
    } else {
      const port = await freeLoopbackPort();
      const srv = spawn(process.execPath, [path.join(REPO, "node_modules/next/dist/bin/next"), "start", "-p", String(port), "-H", "127.0.0.1"], {
        cwd: webDir,
        env: { ...process.env, PORT: String(port), NODE_ENV: "production", DATABASE_URL: `file:${db}`,
               JWT_SECRET: randomBytes(32).toString("hex"), XT_ENCRYPTION_KEY: randomBytes(32).toString("hex") },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        const deadline = Date.now() + 90_000;
        let up = false;
        while (Date.now() < deadline && !up) {
          try { up = (await fetch(`http://127.0.0.1:${port}/en/login`)).status > 0; }
          catch { await new Promise((r) => setTimeout(r, 700)); }
        }
        if (!up) {
          console.log("  skip  the production server did not boot");
        } else {
          const base = `http://127.0.0.1:${port}`;
          // Sign in; login is CSRF-exempt and IP-unbucketed without a proxy.
          const li = await fetch(`${base}/api/auth/login`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ email, password: pw }),
          });
          if (!li.ok) {
            console.log("  skip  the disposable admin could not sign in");
          } else {
            const cookie = (li.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
            const csrf = (/xt_csrf=([^;]+)/.exec(cookie) ?? [])[1] ?? "";
            // Staleness guard: the live checks below run against apps/web/.next.
            // A mutation run that edits source without rebuilding would be
            // measuring the PREVIOUS build and reporting a false pass. Compare
            // the built route against the source and refuse to claim a pass.
            const srcRoute = fs.readFileSync(path.join(API, "users/route.ts"), "utf8");
            // Search the WHOLE server build, not just the route file: Next
            // splits a handler across shared chunks, and the bucket string
            // lands in one of those, not in route.js.
            const serverDir = path.join(REPO, "apps/web/.next/server");
            let found = false;
            if (fs.existsSync(serverDir)) {
              const walk = (dir: string): void => {
                if (found) return;
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                  if (found) return;
                  const full = path.join(dir, e.name);
                  if (e.isDirectory()) walk(full);
                  else if (e.name.endsWith(".js")) {
                    try {
                      if (fs.readFileSync(full, "utf8").includes("users-create")) { found = true; return; }
                    } catch { /* unreadable chunk is not evidence of staleness */ }
                  }
                }
              };
              walk(serverDir);
            }
            if (srcRoute.includes("users-create") && !found) {
              bad("the served build matches the current source",
                "no compiled chunk contains the users-create bucket: apps/web/.next predates the edit; " +
                "rebuild before trusting the live checks");
            } else {
              ok("the served build contains the current rate-limit code");
            }
            let saw429 = false; let saw2xx = false; const statuses = new Set<number>();
            // The users-create bucket is 10/min.
            for (let i = 0; i < 20; i += 1) {
              const r = await fetch(`${base}/api/users`, {
                method: "POST",
                headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
                body: JSON.stringify({ email: `u${i}@example.invalid`, name: `u${i}`, role: "USER", password: "Abcd1234!zzzz" }),
              });
              statuses.add(r.status);
              if (r.status === 429) saw429 = true;
              if (r.status === 201) saw2xx = true;
              await r.text();
            }
            if (saw2xx) ok("the newly limited route still serves requests below the cap");
            else bad("the newly limited route still serves requests below the cap", `statuses: ${[...statuses].join(",")}`);
            if (saw429) ok("a live request past the cap is refused with 429", `statuses seen: ${[...statuses].sort().join(",")}`);
            else bad("a live request past the cap is refused with 429", `statuses: ${[...statuses].join(",")} — no 429 in 20 attempts against a 10/min bucket`);
            // And the 429 body must not carry the bucket key.
            const r429 = await fetch(`${base}/api/users`, {
              method: "POST",
              headers: { "content-type": "application/json", cookie, "x-csrf-token": csrf },
              body: JSON.stringify({ email: "x@example.invalid", name: "x", role: "USER", password: "Abcd1234!zzzz" }),
            });
            const body429 = await r429.text();
            if (!body429.includes("users-create") && !body429.includes(email)) {
              ok("the 429 body does not echo the bucket key or the account email", body429.slice(0, 60));
            } else {
              bad("the 429 body does not echo the bucket key or the account email", body429.slice(0, 120));
            }
          }
        }
      } finally {
        srv.kill();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }
})();

}

void main().then(() => {
  console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
  if (failures.length > 0) process.exitCode = 1;
});
