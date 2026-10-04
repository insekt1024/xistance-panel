/**
 * Shared browser-suite harness (TASK-51).
 *
 * Extracted from test-smoke-auth.ts so the node/tunnel suite does not copy 300
 * lines of Chromium discovery, port allocation and assertion plumbing. A COPY is
 * worse than a duplicate: the two would drift, and a fix to the resolver would
 * silently apply to only half the suites.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { pickPort } from "./pick-port";
import { findChromiumExecutable } from "./chromium-path";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const EXIT_SKIP = 77;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const require_ = createRequire(path.join(process.cwd(), "noop.js"));
export const REPO = process.cwd();
export const WEB = path.join(REPO, "apps/web");

export interface Browser { newContext(): Promise<Context>; close(): Promise<void>; }
export interface Context {
  newPage(): Promise<Page>;
  cookies(): Promise<{ name: string; value: string }[]>;
}
export interface Page {
  goto(url: string, opts?: Record<string, unknown>): Promise<unknown>;
  click(sel: string, opts?: Record<string, unknown>): Promise<void>;
  fill(sel: string, value: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
  on(event: string, handler: (...args: unknown[]) => void): void;
}
export interface PW { chromium: { launch(opts: Record<string, unknown>): Promise<Browser> } }
export function findPlaywright(): PW | null {
  // Resolve the REAL installed dependency first. `playwright-core` is a pinned
  // devDependency (1.63.0), so a normal require always succeeds on any host.
  //
  // The npx-cache hunt below was the ONLY resolution path until recently, and
  // that is why suites importing THIS harness skipped on CI while passing on a
  // developer machine: `npx playwright install` caches under a transient hash,
  // so a clean Linux runner has a different cache layout -- or none. This is
  // the shared helper, so the bug affected every gate suite at once.
  try { return require_("playwright-core") as PW; } catch { /* fall through */ }

  const candidates = [
    path.join(os.homedir(), "AppData/Local/npm-cache/_npx"),
    path.join(os.homedir(), "node_modules"),
    path.join(process.cwd(), "node_modules"),
  ];
  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    const roots = base.endsWith("_npx")
      ? fs.readdirSync(base).map((d) => path.join(base, d, "node_modules"))
      : [base];
    for (const root of roots) {
      const p = path.join(root, "playwright-core");
      if (fs.existsSync(p)) {
        try { return require_(p) as PW; } catch { /* next */ }
      }
    }
  }
  return null;
}

export function findChromium(): string | null {
  // Delegated to one shared resolver. Seven copies of this platform-path guess
  // had drifted apart, and all of them missed a modern Linux Playwright install
  // (which writes chromium-<rev>/ AND chromium_headless_shell-<rev>/). See
  // scripts/lib/chromium-path.ts for the full failure.
  return findChromiumExecutable();
}

/* -------------------------------------------------------------------- util */
export function freePort(): Promise<number> {
  // Not `listen(0)`: see lib/pick-port.ts. Windows' ephemeral range is where
  // Hyper-V/WSL/Docker reserve blocks, so a port the OS just handed out can be
  // refused with EACCES moments later.
  return pickPort("127.0.0.1");
}


/** Read a value across the playwright string boundary as JSON, never a bare primitive. */
/**
 * Evaluate a function body in the page and return its value as JSON.
 *
 * JSON.stringify is what makes the value survive the Playwright bridge: returning
 * a raw object from the inner IIFE hands back a handle instead of data, and
 * returning a bare string means JSON.parse gets "/en/login" and throws.
 */
export const readJson = async <T>(page: Page, body: string): Promise<T> =>
  JSON.parse(await page.evaluate<string>(`JSON.stringify((() => { ${body} })())`)) as T;

/* ------------------------------------------------------------------ server */

/** Assertion recorder. A `bad` carries the evidence that explains the failure. */
export class Checks {
  pass = 0;
  readonly failures: string[] = [];
  readonly skipped: string[] = [];

  /**
   * Record a passing check. Use it only when the condition is ALREADY known to
   * hold -- an if/else that calls ok on one branch and bad on the other.
   *
   * To assert a condition, use `expect(name, condition, extra)`. `expect` is a
   * separate method rather than an optional third parameter on purpose: a
   * boolean argument that can be forgotten is a vacuous assertion that reports
   * "ok" whether or not the behaviour is present, and a suite full of those
   * looks green while proving nothing.
   */
  ok(name: string, extra = ""): void {
    this.pass += 1;
    console.log(`  ok   ${name}${extra ? ` — ${extra}` : ""}`);
  }

  /** Assert a condition. `ok` when true, `bad` with `extra` when false. */
  expect(name: string, when: boolean, extra = ""): void {
    if (when) this.ok(name, extra);
    else this.bad(name, extra || "condition was false");
  }

  bad(name: string, detail: string): void {
    this.failures.push(name);
    console.log(`  FAIL ${name}\n       ${detail}`);
  }

  /**
   * Record that a SUB-SCOPE could not be exercised, and continue.
   *
   * This used to `process.exit`, which discarded every result the suite had
   * already collected: the run ended with no `--- N passed, M failed ---`
   * summary and a skip exit code, so genuine failures above were invisible.
   * A partial-coverage skip is a fact about coverage; it must not erase the
   * rest of the report.
   *
   * It is NOT the way to say "this suite cannot run at all" (no production
   * build, no Chromium). For that, exit with EXIT_SKIP and a printed reason, so
   * a missing prerequisite is never mistaken for a run that simply found no
   * failures. See `bail()` in scripts/test-smoke-nodes-tunnels.ts.
   */
  skip(why: string): void {
    this.skipped.push(why);
    console.log(`  SKIP ${why}`);
  }

  report(): number {
    const skipNote = this.skipped.length ? `, ${this.skipped.length} skipped` : "";
    console.log(`\n--- ${this.pass} passed, ${this.failures.length} failed${skipNote} ---`);
    if (this.failures.length) {
      console.log("\nFailures:");
      for (const f of this.failures) console.log(`  - ${f}`);
    }
    return this.failures.length === 0 ? 0 : 1;
  }
}

export interface AppHandle {
  origin: string;
  cookies: () => Promise<Array<{ name: string; value: string }>>;
  close: () => Promise<void>;
  log: () => string;
}

export interface AppOptions {
  db: string;
  port: number;
  adminEmail: string;
  adminPassword: string;
  /**
   * Boot WITHOUT running migrations or creating the admin.
   *
   * Needed to test a genuinely unreachable database: `startApp` otherwise
   * creates the file, so pointing it at a bad path silently repairs the fault
   * before the server ever sees it. A caller that sets this gets exactly the
   * database state it left on disk.
   */
  skipProvision?: boolean;
}

/**
 * Boot the REAL production build on a disposable database.
 *
 * `next start` from apps/web, never the standalone server: the standalone server
 * bundles its own Prisma client, so a database created by apply-migrations.mjs is
 * invisible to it and every login fails with a misleading "invalid credentials".
 */
export async function startApp(opts: AppOptions): Promise<AppHandle> {
  // Only the provisioning path is allowed to create the database's directory.
  // A caller testing an unopenable database passes `skipProvision` precisely
  // so the fault is still in place when the server boots -- mkdir here would
  // repair it before the first request, which is the trap this option exists to
  // avoid.
  if (!opts.skipProvision) {
    fs.mkdirSync(path.dirname(opts.db), { recursive: true });

    // --migrations is explicit. The applier's own default resolves next to the
    // SCRIPT, which is scripts/ in the repository -- and that directory has no
    // migrations, because they live in packages/db/prisma/migrations and only
    // the STAGED payload has a copy beside its applier. A bare invocation
    // therefore finds nothing and, before the default was fixed, exited 0 with
    // "nothing to apply". Name the directory.
    const mig = spawnSyncSafe(process.execPath, [
      path.join(REPO, "scripts/apply-migrations.mjs"),
      "--database", opts.db,
      "--migrations", path.join(REPO, "packages", "db", "prisma", "migrations"),
    ]);
    if (mig.status !== 0) throw new Error(`migrations failed: ${(mig.stderr || mig.stdout || "").slice(-400)}`);

    const adm = spawnSyncSafe(process.execPath, [
      path.join(REPO, "scripts/create-admin.mjs"), "--database", opts.db,
      "--email", opts.adminEmail, "--password", opts.adminPassword,
    ]);
    if (adm.status !== 0) throw new Error(`admin bootstrap failed: ${(adm.stderr || adm.stdout || "").slice(-400)}`);
  }

  const nextBin = path.join(REPO, "node_modules/next/dist/bin/next");
  // A previous run's `next start` can still hold the old .next; make sure we are
  // about to serve a build whose chunks match the current source. The
  // "SelectItem must be used within Select" error survived a successful rebuild
  // purely because the browser reused a cached chunk.
  const child: ChildProcess = spawn(
    process.execPath,
    [nextBin, "start", "-p", String(opts.port), "-H", "127.0.0.1"],
    {
      cwd: WEB,
      env: {
        ...process.env,
        DATABASE_URL: `file:${opts.db.replace(/\\/g, "/")}`,
        // Test-only secrets. Real values never appear in this repo.
        XT_SESSION_SECRET: "harness-secret-0123456789abcdef0123456789abcdef",
        XT_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        // getJwtSecret() THROWS when NODE_ENV=production and this is unset, so
        // every /api/auth/login answered 500 -- "login failed: HTTP 500" across
        // six suites -- on a machine without apps/web/.env.local.
        //
        // It went unnoticed for the opposite reason: the harness runs
        // NODE_ENV=production unconditionally, but `next start` also loads
        // .env.local from apps/web, and that file exists on the developer's
        // machine and is correctly gitignored. So the suites passed locally and
        // failed in CI, for a missing file rather than a missing setting.
        JWT_SECRET: process.env.JWT_SECRET ?? "harness-jwt-secret-0123456789abcdef0123456789abcdef",
        XT_TRUST_PROXY: "false",
        // The engine's REMOTE config dir is a POSIX path (/etc/xistance) that
        // becomes "\etc\xistance" on Windows, so any deploy through the remote
        // runner fails there. Forcing the local node process manager keeps the
        // test on the path a dev machine can actually execute, which is what
        // these suites are for. The real remote path stays /etc/xistance.
        XT_FORCE_NODE: "true",
        // Keep generated state inside the disposable directory.
        XT_DATA_DIR: path.join(path.dirname(opts.db), "data"),
        NODE_ENV: "production",
        PORT: String(opts.port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  child.stdout?.on("data", (d: Buffer) => { log += String(d); });
  child.stderr?.on("data", (d: Buffer) => { log += String(d); });

  const origin = `http://127.0.0.1:${opts.port}`;
  // Readiness means "the server is answering", NOT "everything is healthy".
  // /api/health answers 503 with a JSON body when a dependency is down -- that
  // is the CORRECT behaviour, and a caller booting an instance with a
  // deliberately broken database must be able to get a handle to it. Gating on
  // `r.ok` made the correct response look like a server that failed to start.
  const SERVING = new Set([200, 401, 403, 404, 500, 503]);
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${origin}/api/health`);
      if (SERVING.has(r.status)) {
        return {
          origin,
          cookies: async () => cookieJarFrom(origin),
          close: async () => { child.kill(); },
          log: () => log,
        };
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`the app never became healthy:\n${log.slice(-1200)}`);
}

export async function cookieJarFrom(origin: string): Promise<Array<{ name: string; value: string }>> {
  // A non-2xx response is fine here: cookies, if any, ride on the headers
  // regardless, and this helper must not fail just because /api/health
  // correctly reports a degraded dependency.
  const r = await fetch(`${origin}/api/health`);
  const out: Array<{ name: string; value: string }> = [];
  for (const sc of r.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) out.push({ name: pair.slice(0, eq), value: pair.slice(eq + 1) });
  }
  return out;
}

function spawnSyncSafe(cmd: string, args: string[]) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  return spawnSync(cmd, args, { cwd: REPO, encoding: "utf8" });
}
