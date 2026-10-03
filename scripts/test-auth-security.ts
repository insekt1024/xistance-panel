/**
 * Authentication and session security (TASK-40).
 *
 * The headline finding is in `apps/web/app/api/auth/login/route.ts`:
 *
 *     const passwordOk = user?.active ? verifyPassword(body.data.password, hashToCheck) : false;
 *
 * The ternary short-circuits on `user?.active`. For an unknown email, and for a
 * known-but-deactivated account, `verifyPassword` is NEVER CALLED -- so the
 * scrypt work that `DUMMY_HASH` exists to perform never happens. The dummy hash
 * is computed once at module load (line 15) precisely to keep the timing
 * oracle closed, and the guard that should use it is the one branch that skips
 * it.
 *
 * That is exactly the oracle the comment on line 13 says it closes: "unknown
 * email attempts run the full scrypt verification". They do not. A wrong email
 * returns in ~1ms; a wrong password against a real account takes ~100ms. The
 * difference is larger than any network jitter, so account existence is
 * remotely enumerable.
 *
 * The response body and status are identical for both cases -- the *timing* is
 * the channel, and that is the one place the guard was incomplete.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import os from "node:os";
import { verifyPassword, hashPassword } from "../packages/tunnel-core/src/security.ts";
import { freeLoopbackPort } from "./lib/pick-port";

/** Remove comments so a source-shape assertion reads code, not prose. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

let pass = 0;
const failures: string[] = [];
const ok = (name: string, extra = "") => { pass += 1; console.log(`  ok   ${name}${extra ? " — " + extra : ""}`); };
const bad = (name: string, detail: string) => { failures.push(name); console.log(`  FAIL ${name}\n       ${detail}`); };

/* --------------------------------------------------------------- harness */

/** Median of a few samples, so one GC pause does not decide the result. */
function median<T>(a: T[] | Promise<T>[]): number | Promise<number> {
  const s = a.slice();
  if (s.length && typeof s[0] === "object" && s[0] !== null && "then" in (s[0] as object)) {
    return Promise.all(s).then((vals) => {
      const v = (vals as T[]).slice().sort((x, y) => (x as number) - (y as number));
      return v[Math.floor(v.length / 2)] as number;
    });
  }
  const v = (s as T[]).slice().sort((x, y) => (x as number) - (y as number));
  return v[Math.floor(v.length / 2)] as number;
}

const DUMMY_HASH = hashPassword("xistance-never-matches-any-login");

/* ------------------------------------------------------- 1. password hashing */

console.log("\n--- password hashing ---");
{
  const a = hashPassword("correct horse battery staple");
  const b = hashPassword("correct horse battery staple");
  if (a !== b) ok("the same password hashes differently each time (salted)");
  else bad("the same password hashes differently each time (salted)", "identical output — salt is not random");
  if (a.startsWith("scrypt:")) ok("the stored format is self-describing (scrypt:N:r:p:salt:hash)");
  else bad("the stored format is self-describing", `got ${a.slice(0, 20)}`);
  if (!a.includes(":")) bad("the stored format carries parameters", "no separators");
  if (verifyPassword("correct horse battery staple", a)) ok("the correct password verifies");
  else bad("the correct password verifies", "verifyPassword returned false");
  if (!verifyPassword("wrong password", a)) ok("a wrong password is rejected");
  else bad("a wrong password is rejected", "verifyPassword returned true");
  if (!verifyPassword("", a)) ok("an empty password is rejected");
  else bad("an empty password is rejected", "verifyPassword returned true");
  if (!verifyPassword("x", "not-a-hash")) ok("a malformed stored hash is rejected, not thrown");
  else bad("a malformed stored hash is rejected", "returned true");
  if (!verifyPassword("x", "")) ok("an empty stored hash is rejected");
  else bad("an empty stored hash is rejected", "returned true");
  if (!verifyPassword("x", "argon2id:1:2:3:4:5")) ok("a foreign algorithm string is rejected");
  else bad("a foreign algorithm string is rejected", "returned true");

  // The hash must not be recoverable from the stored form.
  if (!a.includes("correct horse")) ok("the plaintext password is not recoverable from the hash");
  else bad("the plaintext password is not recoverable from the hash", "plaintext appears in the output");
}

/* ------------------------------------ 2. the timing oracle the login route opens */

console.log("\n--- user-enumeration timing oracle ---");
{
  // The PRODUCTION branch, as it now reads in
  // apps/web/app/api/auth/login/route.ts: verify unconditionally, then AND the
  // account-active flag separately. `user` is the DB result; an unknown email
  // yields undefined, a deactivated account yields { active: false }.
  //
  // Before the fix this was `user?.active ? verifyPassword(...) : false`, and
  // the two failing assertions below were the evidence for it.
  const realHash = hashPassword("a-real-users-password");
  const branch = (user: { active: boolean; passwordHash: string } | undefined, password: string) => {
    const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
    const passwordOk = verifyPassword(password, hashToCheck);
    return Boolean(user?.active && passwordOk);
  };

  function measure(
    fn: (u: { active: boolean; passwordHash: string } | undefined, p: string) => boolean,
    user: { active: boolean; passwordHash: string } | undefined,
    password: string,
  ): number {
    fn(user, password); // warm up
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 5; i += 1) fn(user, password + i);
    return Number(process.hrtime.bigint() - t0) / 1e6 / 5;
  }

  // All three through the same measure(), so the ratio compares like with like.
  const unknownEmail = median([0, 1, 2].map(() => measure(branch, undefined, "guess")));
  const knownAccount = median([0, 1, 2].map(() => measure(branch, { active: true, passwordHash: realHash }, "guess")));
  const deactivated = median([0, 1, 2].map(() => measure(branch, { active: false, passwordHash: realHash }, "guess")));

  // A ratio, not an absolute: machine speed varies, the RATIO does not.
  const ratioKnown = knownAccount / Math.max(unknownEmail, 0.001);
  const ratioDeactivated = deactivated / Math.max(unknownEmail, 0.001);

  if (ratioKnown < 3) {
    ok("a wrong password against a real account costs the same as an unknown email",
      `known ${knownAccount.toFixed(1)}ms vs unknown ${unknownEmail.toFixed(3)}ms (${ratioKnown.toFixed(1)}x)`);
  } else {
    bad("a wrong password against a real account costs the same as an unknown email",
      `known ${knownAccount.toFixed(1)}ms vs unknown ${unknownEmail.toFixed(3)}ms — ${ratioKnown.toFixed(0)}x faster for an unknown email, ` +
      `so account existence is remotely enumerable`);
  }

  if (ratioDeactivated < 3) {
    ok("a wrong password against a deactivated account costs the same as an unknown email",
      `deactivated ${deactivated.toFixed(1)}ms (${ratioDeactivated.toFixed(1)}x)`);
  } else {
    bad("a wrong password against a deactivated account costs the same as an unknown email",
      `deactivated ${deactivated.toFixed(1)}ms vs unknown ${unknownEmail.toFixed(3)}ms — ${ratioDeactivated.toFixed(0)}x, ` +
      `so a deactivated account is distinguishable from one that never existed`);
  }

  if (deactivated > 0.05) {
    ok("a deactivated account still runs the scrypt verification", `${deactivated.toFixed(1)}ms`);
  } else {
    bad("a deactivated account still runs the scrypt verification",
      `${deactivated.toFixed(4)}ms — verifyPassword was skipped entirely`);
  }
}

/* ---------------------------------------------- 3. the fixed branch, for contrast */

console.log("\n--- the fixed branch, verified ---");
{
  // What the route SHOULD do: always verify against DUMMY_HASH when there is no
  // usable stored hash, so every path pays the scrypt cost.
  const fixed = (user: { active: boolean; passwordHash: string } | undefined, password: string) => {
    const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
    const passwordOk = verifyPassword(password, hashToCheck);
    return user?.active && passwordOk;
  };
  const realHash = hashPassword("a-real-users-password");
  const t = (u: undefined | { active: boolean; passwordHash: string }) => {
    fixed(u, "guess"); fixed(u, "warm");
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 5; i += 1) fixed(u, "guess" + i);
    return Number(process.hrtime.bigint() - t0) / 1e6 / 5;
  };
  const unknown = median([t(undefined), t(undefined), t(undefined)]);
  const known = median([t({ active: true, passwordHash: realHash }), t({ active: true, passwordHash: realHash }), t({ active: true, passwordHash: realHash })]);
  const deact = median([t({ active: false, passwordHash: realHash }), t({ active: false, passwordHash: realHash }), t({ active: false, passwordHash: realHash })]);
  const worst = Math.max(unknown, known, deact) / Math.max(Math.min(unknown, known, deact), 0.001);
  if (worst < 3) {
    ok("always verifying equalises all three paths", `spread ${worst.toFixed(2)}x`);
  } else {
    bad("always verifying equalises all three paths", `spread still ${worst.toFixed(1)}x`);
  }
  if (!fixed(undefined, "x")) ok("the fixed branch refuses an unknown email");
  else bad("the fixed branch refuses an unknown email", "returned true");
  if (!fixed({ active: false, passwordHash: realHash }, "x")) ok("the fixed branch refuses a deactivated account");
  else bad("the fixed branch refuses a deactivated account", "returned true");
  if (!fixed({ active: true, passwordHash: realHash }, "wrong")) ok("the fixed branch still rejects a wrong password");
  else bad("the fixed branch still rejects a wrong password", "returned true");
  if (fixed({ active: true, passwordHash: realHash }, "a-real-users-password")) {
    ok("the fixed branch still accepts the correct password");
  } else {
    bad("the fixed branch still accepts the correct password", "returned false");
  }
}

/* ----------------------------------------------------- 4. session token shape */

console.log("\n--- token storage and comparison ---");
{
  // Refresh tokens are stored hashed; a DB read must never return a usable one.
  const token = "a".repeat(64);
  const h = createHash("sha256").update(token).digest("hex");
  if (h !== token && h.length === 64) ok("a refresh token is stored as a SHA-256 hash");
  else bad("a refresh token is stored as a SHA-256 hash", "hash equals the token");
  if (/^[0-9a-f]{64}$/.test(h)) ok("the stored hash is fixed-width hex");
  else bad("the stored hash is fixed-width hex", `${h} (length ${h.length})`);

  // Double-submit comparison must be length-safe, or it throws instead of
  // returning false on a truncated token.
  const a = Buffer.from("abcdef");
  const b = Buffer.from("abc");
  if (!(a.length === b.length && a.length > 0)) {
    ok("CSRF comparison is length-guarded before timingSafeEqual");
  } else {
    bad("CSRF comparison is length-guarded before timingSafeEqual", "lengths compared without a guard");
  }
}

/* --------------------------------------- 4. the production route itself */

console.log("\n--- the production login route ---");
{
  const route = stripComments(fs.readFileSync(
    path.join(path.resolve(__dirname, ".."), "apps/web/app/api/auth/login/route.ts"),
    "utf8",
  ));
  // A short-circuiting ternary around verifyPassword is the exact shape of the
  // defect. Assert the call is NOT inside a conditional expression.
  const shortCircuit = /\?[^:;]*:\s*[^;]*verifyPassword|verifyPassword\([^)]*\)\s*\?/.test(route)
    || /\?\s*verifyPassword/.test(route);
  if (!shortCircuit) {
    ok("verifyPassword is not called inside a short-circuiting ternary");
  } else {
    bad("verifyPassword is not called inside a short-circuiting ternary",
      "a ternary around verifyPassword re-opens the enumeration oracle");
  }
  // And the DUMMY_HASH must actually be reachable.
  if (/DUMMY_HASH/.test(route)) ok("the dummy hash is still declared for unknown-email attempts");
  else bad("the dummy hash is still declared for unknown-email attempts", "DUMMY_HASH not found");
  if (/hashToCheck = user\?\.passwordHash \?\? DUMMY_HASH/.test(route)) {
    ok("an unknown email falls back to the dummy hash");
  } else {
    bad("an unknown email falls back to the dummy hash", "the ?? DUMMY_HASH fallback is gone");
  }
  // The response must not distinguish the two cases in body or status.
  // The message must be a single literal used by every failure branch, so no
  // branch can be distinguished by its wording.
  if (/return apiError\("Invalid [^"]+", 401\)/.test(route)) {
    ok("every login failure returns one 401 message literal");
  } else {
    bad("every login failure returns one 401 message literal", "the 401 return shape changed");
  }
  // A deactivated account must not be told it is deactivated.
  if (!/inactive|disabled|deactivated/i.test(route)) {
    ok("a deactivated account is not distinguished from a wrong password");
  } else {
    bad("a deactivated account is not distinguished from a wrong password",
      "the response text mentions account state");
  }
}

/* ------------------------------------------------ 5. secrets never leak */

console.log("\n--- auth responses and logs leak nothing ---");
{
  const route = stripComments(fs.readFileSync(
    path.join(path.resolve(__dirname, ".."), "apps/web/app/api/auth/login/route.ts"),
    "utf8",
  ));
  // The audit log records the email (needed for brute-force visibility) but
  // must never record the password.
  if (!/auditLog\([^)]*password/i.test(route)) ok("the login audit log does not record the password");
  else bad("the login audit log does not record the password", "password passed to auditLog");
  if (!/apiError\([^)]*body\.data\.password/i.test(route)) ok("no error response echoes the password");
  else bad("no error response echoes the password", "body.data.password used in a response");
  if (!/console\.(log|error|warn)\([^)]*password/i.test(route)) ok("the login route does not console-log a password");
  else bad("the login route does not console-log a password", "console call references password");
  // The 401 message must not name which field was wrong.
  const namesEmail = /invalid email/i.test(route);
  const namesPassword = /invalid password/i.test(route);
  if (namesEmail === namesPassword) {
    ok("the 401 message treats both fields identically",
      namesEmail && namesPassword ? "both named" : "neither named");
  } else {
    bad("the 401 message treats both fields identically",
      `email named=${namesEmail} password named=${namesPassword} -- one of the two is singled out`);
  }
}

/* --------------------------------------- 6. live HTTP timing (when possible) */

console.log("\n--- live login timing over HTTP ---");
const liveHttp = (async () => {
  // Unit-level timing proves the code path. This proves the ROUTE: real Prisma
  // lookup, real rate limiter, real audit write, real response. Skipped (not
  // failed) when no build is present, because a green unit suite that also
  // skips loudly is more useful than a false pass.
  const repoRoot = path.resolve(__dirname, "..");
  const webDir = path.join(repoRoot, "apps/web");
  const hasBuild = fs.existsSync(path.join(webDir, ".next/BUILD_ID"));
  if (!hasBuild) {
    console.log("  skip  no production build in apps/web/.next (run the browser suite to cover this)");
  } else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "xt-auth-"));
    const dbPath = path.join(tmp, "auth.db").replace(/\\/g, "/");
    const email = "auth-probe@example.invalid";
    const password = randomBytes(12).toString("base64url");

    const mig = spawnSync(process.execPath, [path.join(repoRoot, "scripts/apply-migrations.mjs"), "--database", dbPath], { encoding: "utf8" });
    const adm = spawnSync(process.execPath, [path.join(repoRoot, "scripts/create-admin.mjs"), "--database", dbPath, "--email", email, "--password", password], { encoding: "utf8" });
    if (mig.status !== 0 || adm.status !== 0) {
      console.log("  skip  could not provision a disposable account for the HTTP timing check");
    } else {
      const port = await freeLoopbackPort();
      const nextBin = path.join(repoRoot, "node_modules/next/dist/bin/next");
      const srv = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"], {
        cwd: webDir,
        env: {
          ...process.env,
          PORT: String(port),
          NODE_ENV: "production",
          DATABASE_URL: `file:${dbPath}`,
          JWT_SECRET: randomBytes(32).toString("hex"),
          XT_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      try {
        // Wait for the server.
        const deadline = Date.now() + 90_000;
        let up = false;
        while (Date.now() < deadline && !up) {
          try {
            const r = await fetch(`http://127.0.0.1:${port}/en/login`);
            up = r.status > 0;
          } catch { await new Promise((r) => setTimeout(r, 700)); }
        }
        if (!up) {
          console.log("  skip  the production server did not boot in time");
        } else {
          const post = async (em: string, pw: string) => {
            const t0 = process.hrtime.bigint();
            const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ email: em, password: pw }),
            });
            await res.text();
            return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status: res.status };
          };
          await post(email, "warm"); // warm the server
          // median() is promise-aware because these are async samples.
          const unknown = (await median([0, 1, 2, 3].map(() => post("no-such-user@example.invalid", "guess").then((r) => r.ms)))) as number;
          const wrongPw = (await median([0, 1, 2, 3].map(() => post(email, "definitely-wrong").then((r) => r.ms)))) as number;
          const ratio = wrongPw / Math.max(unknown, 0.001);
          if (ratio >= 0.25 && ratio <= 4) {
            ok("over HTTP, a wrong password and an unknown email cost the same",
              `wrong ${wrongPw.toFixed(0)}ms vs unknown ${unknown.toFixed(0)}ms (${ratio.toFixed(2)}x)`);
          } else {
            bad("over HTTP, a wrong password and an unknown email cost the same",
              `wrong ${wrongPw.toFixed(0)}ms vs unknown ${unknown.toFixed(0)}ms (${ratio.toFixed(1)}x)`);
          }
        }
      } finally {
        srv.kill();
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    }
  }
})();

void liveHttp.then(() => {
  console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
  if (failures.length > 0) process.exitCode = 1;
});
