/**
 * Boot the Next STANDALONE server (the release runtime) for a local asset smoke
 * test.
 *
 * Distinct from `startApp` in `browser-harness.ts`, which deliberately runs
 * `next start` from the source tree. That is the right default for behavioural
 * tests: the standalone server bundles its own Prisma client, so a database
 * created by the repo's `apply-migrations.mjs` is invisible to it and every
 * login fails with a misleading "invalid credentials".
 *
 * This module exists for the opposite question. TASK-55 asks what the RELEASE
 * RUNTIME serves -- does the panel boot without the source tree, and do the
 * assets a localized page references actually exist in the artifact. A
 * `next start` server answers that by reading the source tree, so it would pass
 * while the artifact 404s every stylesheet. The standalone server reads only
 * what was staged.
 *
 * Prisma engine: the standalone tree carries whichever engines `prisma generate`
 * produced, which on a development machine includes the host's own. The RELEASE
 * artifact strips the others (single-architecture by design), so this runs where
 * the release targets and exits 77 elsewhere -- see `assertEngineAvailable`.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { REPO } from "./browser-harness";
import { pickPort } from "./pick-port";

export const EXIT_SKIP = 77;

export interface StagedAppHandle {
  origin: string;
  port: number;
  password: string;
  /**
   * The server process id.
   *
   * Exposed because peak resident memory can only be sampled against a real pid.
   * Without it a benchmark's `peakRssBytes` would be a confident 0 -- an
   * unimplemented measurement that reads exactly like a result proving the
   * server needs no memory.
   */
  readonly pid: number;
  /** Peak RSS observed from spawn to first healthy response. */
  readonly startupPeakRssBytes: number;
  /** How many samples that peak was drawn from; 0 means unmeasurable here. */
  readonly startupMemorySamples: number;
  /** Every line the server wrote to stderr, for leak assertions. */
  stderr: string[];
  log: () => string;
  /**
   * Wall-clock milliseconds from the stop request to process exit, or null if
   * the process was already gone. A slow shutdown is what makes a service
   * manager's stop timeout fire and escalate to SIGKILL, so it belongs in a
   * resource budget next to startup time -- not just in a teardown path.
   */
  readonly shutdownMs: number | null;
  /**
   * True when the process only exited because stop() escalated to SIGKILL after
   * its 5s grace. A shutdown that always needs killing is a defect that a
   * duration figure alone would average away.
   */
  readonly shutdownForced: boolean;
  stop: () => Promise<void>;
}

function tempRoot(): string {
  return process.env.TMPDIR || process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp";
}

export async function freePort(): Promise<number> {
  // Delegates to the hardened allocator: Windows' ephemeral range is where
  // Hyper-V/WSL/Docker reserve blocks, and `listen(0)` draws from exactly that
  // pool. See lib/pick-port.ts for the full failure this avoids.
  return pickPort("127.0.0.1");
}

/** The Prisma query engine this host needs, or null when it is not obvious. */
export function requiredEngine(): string | null {
  if (process.platform === "win32") return "query_engine-windows.dll.node";
  if (process.platform === "linux") {
    // glibc hosts load the debian build; a musl host cannot, and there is no
    // reliable runtime probe for that, so prefer the more common one and let a
    // load failure surface as a real error rather than a silent skip.
    return "libquery_engine-debian-openssl-3.0.x.so.node";
  }
  return null;
}

/**
 * Exit 77 with an explanation when the staged tree cannot run here.
 *
 * A missing engine must never read as "the suite passed": the artifact is
 * single-architecture, so a host without a matching engine has proved nothing
 * about the assets.
 */
export function assertEngineAvailable(standaloneRoot: string): void {
  const needed = requiredEngine();
  if (needed === null) return;
  const clientDir = path.join(standaloneRoot, "packages", "db", "generated", "client");
  if (fs.existsSync(path.join(clientDir, needed))) return;
  const shipped = fs.existsSync(clientDir)
    ? fs.readdirSync(clientDir).filter((e) => e.endsWith(".node"))
    : [];
  console.error(
    `This host (${process.platform}/${process.arch}) needs ${needed}, but the staged tree ships only: ` +
      `${shipped.join(", ") || "no engine at all"}.\n` +
      `The release artifact is single-architecture by design, so this test only runs where the ` +
      `release targets. Stage for this platform to run it locally.`,
  );
  process.exit(EXIT_SKIP);
}

export interface StagedAppOptions {
  /** The Next standalone root, e.g. apps/web/.next/standalone */
  standaloneRoot: string;
  db: string;
  port: number;
  adminEmail: string;
  adminPassword: string;
}

export async function startStagedApp(opts: StagedAppOptions): Promise<StagedAppHandle> {
  assertEngineAvailable(opts.standaloneRoot);

  const appDir = path.join(opts.standaloneRoot, "apps", "web");
  fs.mkdirSync(path.dirname(opts.db), { recursive: true });

  // Migrations and the admin come from the STAGED copies, not the repo's, so the
  // test also proves those two scripts were shipped and are runnable.
  const migrator = path.join(opts.standaloneRoot, "apply-migrations.mjs");
  const admin = path.join(opts.standaloneRoot, "create-admin.mjs");
  for (const [file, label] of [
    [migrator, "apply-migrations.mjs"],
    [admin, "create-admin.mjs"],
  ] as const) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `${label} is not in the staged artifact at ${file}. The release must ship it: the Prisma CLI ` +
          `is not shipped, so this script is the only way to create the schema on the target host.`,
      );
    }
  }

  // --migrations is passed EXPLICITLY, and not left to apply-migrations.mjs's
  // default. The default resolves next to the script, which is correct, but a
  // caller that stages the payload somewhere else and relies on the default is
  // relying on a path it has not checked. The migration directory ships with the
  // artifact, so naming it here also proves it is present.
  const migrations = path.join(opts.standaloneRoot, "packages", "db", "prisma", "migrations");
  const run = spawnSync(
    process.execPath,
    [migrator, "--database", `file:${opts.db}`, "--migrations", migrations],
    { encoding: "utf8" },
  );
  if (run.status !== 0) {
    throw new Error(`staged apply-migrations.mjs failed: ${(run.stderr || run.stdout || "").slice(-400)}`);
  }
  const adm = spawnSync(
    process.execPath,
    [admin, "--database", `file:${opts.db}`, "--email", opts.adminEmail, "--password", opts.adminPassword],
    { encoding: "utf8" },
  );
  if (adm.status !== 0) {
    throw new Error(`staged create-admin.mjs failed: ${(adm.stderr || adm.stdout || "").slice(-400)}`);
  }

  // Disposable per-run secrets. Never printed, never a real value.
  const sessionSecret = randomBytes(32).toString("hex");
  const encryptionKey = randomBytes(32).toString("hex");

  const stderr: string[] = [];
  // Filled in by stop(); exposed through the handle so a caller that reads the
  // result after teardown can still see how long the exit actually took.
  let shutdown: number | null = null;
  let shutdownForced = false;
  const child: ChildProcess = spawn(process.execPath, [path.join(appDir, "server.js")], {
    cwd: appDir,
    env: {
      ...process.env,
      PORT: String(opts.port),
      HOSTNAME: "127.0.0.1",
      DATABASE_URL: `file:${opts.db.replace(/\\/g, "/")}`,
      NODE_ENV: "production",
      // These are the names install.sh writes into the env file. Guessing
      // `XT_SESSION_SECRET` instead of `JWT_SECRET` costs a confusing 500: the
      // server boots, /api/health answers, and only the first authenticated
      // request reveals the missing secret, with a redacted empty body.
      JWT_SECRET: sessionSecret,
      XTENC_KEY: encryptionKey,
      XT_TRUST_PROXY: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr.push(...chunk.toString().split("\n"));
  });
  child.stdout?.resume();

  // Sample from the moment of spawn, not after readiness. The peak a low-RAM
  // host fails on is the startup burst -- module loading, Prisma engine init,
  // schema check -- and that memory is largely reclaimed before the first
  // request completes. A sampler started after waitForServer would report a
  // steady-state figure and miss the moment the box actually runs out.
  const startupPeak = { bytes: 0, samples: 0 };
  const sampleStartup = (): void => {
    const pid = child.pid;
    if (pid === undefined) return;
    const rss = processRssBytes(pid);
    if (rss === null) return;
    startupPeak.samples += 1;
    if (rss > startupPeak.bytes) startupPeak.bytes = rss;
  };
  const startupTimer = setInterval(sampleStartup, 25);
  startupTimer.unref?.();

  const origin = `http://127.0.0.1:${opts.port}`;
  await waitForServer(origin, child);
  sampleStartup();
  clearInterval(startupTimer);

  return {
    origin,
    port: opts.port,
    password: opts.adminPassword,
    pid: child.pid ?? -1,
    startupPeakRssBytes: startupPeak.bytes,
    startupMemorySamples: startupPeak.samples,
    stderr,
    log: () => stderr.join("\n"),
    get shutdownMs() {
      return shutdown;
    },
    get shutdownForced() {
      return shutdownForced;
    },
    stop: async () => {
      if (child.exitCode === null) {
        // Monotonic: Date.now() can step backwards under NTP and would yield a
        // negative duration, which is indistinguishable from a real measurement
        // of nothing at all.
        const t0 = process.hrtime.bigint();
        child.kill();
        let forced = false;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null) {
              child.kill("SIGKILL");
              forced = true;
            }
            resolve();
          }, 5000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        shutdown = Number(process.hrtime.bigint() - t0) / 1e6;
        // An exit that needed SIGKILL is a different measurement from a clean
        // one, and averaging them would hide a shutdown that only ever completes
        // because it was killed. Reported as a flag, never folded into the time.
        shutdownForced = forced;
      }
    },
  };
}

/**
 * Resident set size of a pid, or null when the platform offers no cheap way to
 * read it. Null is the honest answer: reporting 0 would look like a measurement
 * of a process that needs no memory.
 */
export function processRssBytes(pid: number): number | null {
  if (process.platform === "linux") {
    try {
      const statm = fs.readFileSync(`/proc/${pid}/statm`, "utf8").split(" ");
      const pages = Number(statm[1]);
      return Number.isFinite(pages) ? pages * 4096 : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    // `tasklist` ships with every Windows host; PowerShell is not assumed.
    // Node has no cross-platform RSS API, so this is the available route.
    const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
    if (out.status !== 0) return null;
    // CSV shape is: "Image Name","PID","Session Name","Session#","Memory"
    // so memory is the FIFTH field and carries a " K" suffix. Matching the end
    // of the line (what this did before) never matched, because the row ends
    // with `K"` -- which made peak RSS read a confident 0, indistinguishable from
    // a process that genuinely needs no memory.
    const line = out.stdout.split("\n").find((l) => l.includes(`"${pid}"`));
    if (!line) return null;
    const fields = line.split('","');
    const memField = fields[4];
    if (memField === undefined) return null;
    const kb = Number(memField.replace(/[^0-9.]/g, ""));
    return Number.isFinite(kb) ? Math.round(kb) * 1024 : null;
  }
  return null;
}

/**
 * Wait for the server to answer, and prove it answered the HEALTH endpoint.
 *
 * Polling `/` would accept a listener that answers 500 on every real route. The
 * health probe is the cheapest request that exercises the database, so a server
 * that is up but broken never passes this gate.
 */
async function waitForServer(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`the standalone server exited with code ${child.exitCode} before becoming ready`);
    }
    try {
      const res = await fetch(`${origin}/api/health`);
      if (res.status === 200 || res.status === 503) {
        // 503 is a legitimate DEGRADED answer from a running server, not a
        // readiness failure: the panel is serving, it is reporting a problem.
        // Treating it as a failure would make the suite unable to describe a
        // database outage, which is the state it most needs to describe.
        await res.text();
        return;
      }
      lastError = `health returned ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the standalone server never became ready: ${lastError}`);
}

export interface FetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  location: string | undefined;
}

/** One GET, no redirect following, so the redirect chain itself stays visible. */
export function get(base: string, urlPath: string): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}${urlPath}`, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          location: response.headers.location,
        }),
      );
    });
    request.on("error", reject);
    request.setTimeout(30_000, () => request.destroy(new Error(`GET ${urlPath} timed out`)));
  });
}

export interface FollowResult extends FetchResult {
  finalUrl: string;
  hops: string[];
}

/**
 * Follow redirects and report the chain.
 *
 * `localePrefix` is "as-needed", so a default-locale request legitimately
 * redirects to the unprefixed path. Following rather than failing is correct
 * behaviour, but the hops are kept because a redirect LOOP is a real bug -- and
 * a suite that only checked the final status would see it as success.
 */
export async function follow(base: string, urlPath: string, maxHops = 6): Promise<FollowResult> {
  let current = `${base}${urlPath}`;
  const hops: string[] = [];
  for (let i = 0; i < maxHops; i += 1) {
    const response = await get(base, new URL(current).pathname + new URL(current).search);
    const location = response.location;
    if (response.status >= 300 && response.status < 400 && location) {
      hops.push(response.status.toString());
      current = new URL(location, current).toString();
      continue;
    }
    return { ...response, finalUrl: current, hops };
  }
  const last = await get(base, new URL(current).pathname);
  return { ...last, finalUrl: current, hops: [...hops, "LOOP"] };
}

/** A temporary database path under the scratch directory. */
export function scratchDb(tag: string): string {
  const dir = fs.mkdtempSync(path.join(tempRoot(), `xistance-${tag}-`));
  return path.join(dir, "app.db");
}

export const STAGED_REPO_ROOT = REPO;
