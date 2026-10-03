/**
 * The low-RAM baseline benchmark harness (TASK-57).
 *
 * Produces a machine-readable, sanitized result for one run of the declared
 * workload in `scripts/lib/workload-contract.ts`. The contract is the single
 * source of what the workload IS; this file is only how it is measured.
 *
 *   npx tsx scripts/bench-baseline.ts --out <file.json>
 *   npx tsx scripts/bench-baseline.ts --out base.json --label before
 *   npx tsx scripts/bench-baseline.ts --compare base.json --out candidate.json
 *
 * Measurement rules, and why each exists:
 *
 *   * Monotonic clocks only. `Date.now()` can step backwards under NTP, which
 *     turns one sample into a negative duration and silently poisons a
 *     percentile. `process.hrtime.bigint()` cannot.
 *   * Install/startup and steady-state are separate phases. A panel that takes
 *     40s to migrate a large database is fine to operate once and wrong to run;
 *     averaging the two produces a number that describes neither.
 *   * A run records its host and its workload digest. `--compare` refuses to
 *     compare runs from different hosts or with different workloads, because a
 *     speedup measured on different hardware is not a speedup.
 *   * No tunnel throughput is reported. See the note in the contract: a
 *     control-plane HTTP benchmark cannot support that number, and
 *     `assertNoUnmeasuredClaims` fails the run if one appears.
 *
 * The app under test is the STAGED release payload, booted by
 * `scripts/lib/staged-app.ts`, so the numbers describe what would actually be
 * installed rather than a development server.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertNoUnmeasuredClaims,
  renderTemplate,
  totalRequests,
  WORKLOAD,
  type TemplateContext,
  type WorkloadStep,
} from "./lib/workload-contract";
import { freePort, scratchDb, startStagedApp, type StagedAppHandle } from "./lib/staged-app";

const REPO = path.resolve(__dirname, "..");
const SCHEMA = "xistance.bench-baseline/1";
const ADMIN_EMAIL = "bench@xistance.invalid";
const ADMIN_PASS = "BenchBaselineDisposable!x1";

/**
 * `POST /api/tunnels` allows 10 creates per 60s per user. Read from the route,
 * not assumed: if the limit changes, the budget arithmetic below changes with it
 * instead of silently seeding into a 429.
 */
const TUNNEL_CREATE_LIMIT = 10;
/** How many creates the control workload issues -- read from the contract. */
const TUNNEL_CREATE_WORKLOAD_STEPS = WORKLOAD.phases
  .flatMap((phase) => phase.steps)
  .filter((step) => step.method === "POST" && step.path === "/api/tunnels")
  .reduce((sum, step) => sum + step.count, 0);

interface Sample {
  readonly step: string;
  readonly index: number;
  readonly status: number;
  readonly durationMs: number;
  readonly ok: boolean;
  /**
   * The error message the server returned, for a non-2xx sample.
   *
   * A status code alone is not diagnosable: a 403 here could be a quota, a role
   * check or an origin rejection, and a first run of the harness could not tell
   * which. Truncated and scrubbed, because it is server-authored text about one
   * failed request -- never the request itself.
   */
  readonly error?: string;
}

interface StepSummary {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly count: number;
  readonly okCount: number;
  /** Non-2xx/3xx statuses seen, with counts, so a fast error loop is visible. */
  readonly statuses: Record<string, number>;
  /** Distinct error messages seen, with counts, so a failing step is explicable. */
  readonly errors: Record<string, number>;
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
  readonly bytes: number;
}

interface PhaseSummary {
  readonly phase: string;
  readonly description: string;
  readonly steps: StepSummary[];
  readonly durationMs: number;
  readonly requests: number;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank. Documented because p95 has several definitions and a
  // benchmark that silently changes them is not comparable to itself.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] as number;
}

function summarise(step: WorkloadStep, samples: readonly Sample[], bytes: number): StepSummary {
  const okSamples = samples.filter((s) => s.ok);
  const durations = okSamples.map((s) => s.durationMs).sort((a, b) => a - b);
  const statuses: Record<string, number> = {};
  for (const s of samples) statuses[String(s.status)] = (statuses[String(s.status)] ?? 0) + 1;
  const errors: Record<string, number> = {};
  for (const s of samples) {
    if (s.error !== undefined) errors[s.error] = (errors[s.error] ?? 0) + 1;
  }
  const sum = durations.reduce((a, b) => a + b, 0);
  return {
    id: step.id,
    method: step.method,
    path: step.path,
    count: step.count,
    okCount: okSamples.length,
    statuses,
    errors,
    minMs: durations[0] ?? 0,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxMs: durations[durations.length - 1] ?? 0,
    meanMs: durations.length === 0 ? 0 : Number((sum / durations.length).toFixed(3)),
    bytes,
  };
}

/** Monotonic milliseconds, rounded to microsecond resolution. */
function nowMs(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

function hostInfo(): Record<string, unknown> {
  let swapBytes: number | null = null;
  if (process.platform === "linux") {
    // /proc/meminfo is the only place swap is reported without extra tooling.
    try {
      const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
      const m = meminfo.match(/^SwapTotal:\s+(\d+) kB$/m);
      if (m) swapBytes = Number(m[1]) * 1024;
    } catch { /* not readable: recorded as null, not as zero */ }
  } else if (process.platform === "win32") {
    // Windows exposes no comparable figure without WMI; null is the honest value
    // rather than a fabricated 0, which would read as "no swap configured".
    swapBytes = null;
  }
  return {
    platform: process.platform,
    arch: process.arch,
    osType: os.type(),
    osRelease: os.release(),
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    vcpu: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytesAtStart: os.freemem(),
    swapBytes,
    nodeVersion: process.version,
    cgroupMemoryLimitBytes: cgroupMemoryLimit(),
    cgroupCpuLimit: cgroupCpuLimit(),
  };
}

/** The container memory ceiling, if any — the number that actually matters on a VPS. */
function cgroupMemoryLimit(): number | null {
  const candidates = ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, "utf8").trim();
      if (raw === "max") return null;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* try the next layout */ }
  }
  return null;
}

function cgroupCpuLimit(): string | null {
  try {
    const raw = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim();
    return raw === "max" ? null : raw;
  } catch {
    return null;
  }
}

function directoryBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else {
        try { total += fs.statSync(full).size; } catch { /* raced away */ }
      }
    }
  }
  return total;
}

/**
 * Seed the declared fixture through the real API.
 *
 * The workload contract declares 4 nodes and 8 tunnels; nothing creates them,
 * and the create step needs real node UUIDs. Seeding goes through `/api/nodes`
 * and `/api/tunnels` rather than Prisma directly, so the fixture is subject to
 * the same validation, quota and CSRF rules as any operator request -- a
 * benchmark fixture inserted behind the API's back would not be the shape the
 * control plane actually serves.
 *
 * Node records are local; reachability is a separate fact, so 127.0.0.1:1 is
 * the honest "nothing is listening there".
 */
async function seedFixture(origin: string, session: Session): Promise<{ nodes: string[]; tunnels: number }> {
  const post = async (urlPath: string, body: unknown): Promise<Response> =>
    fetch(`${origin}${urlPath}`, {
      method: "POST",
      headers: {
        cookie: session.cookie,
        origin,
        "content-type": "application/json",
        "x-csrf-token": session.csrf,
      },
      body: JSON.stringify(body),
    });

  const want = WORKLOAD.fixture;
  const nodes: string[] = [];
  for (let i = 0; i < want.nodes; i += 1) {
    // `type` is the node's ROLE (IRAN | FOREIGN), not a transport. The key is a
    // placeholder: this is a local record, nothing dials it.
    const response = await post("/api/nodes", {
      name: `bench-node-${i + 1}`,
      type: i % 2 === 0 ? "IRAN" : "FOREIGN",
      host: "127.0.0.1",
      port: 1,
      username: "root",
      authMethod: "key",
      key: "[PLACEHOLDER NOT A REAL KEY]",
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 200);
      throw new Error(`could not seed node ${i + 1}: HTTP ${response.status} ${body}`);
    }
    const created = (await response.json()) as { node?: { id?: string }; id?: string };
    const id = created.node?.id ?? created.id;
    if (!id) throw new Error(`seeding node ${i + 1} returned no id`);
    nodes.push(id);
  }

  // `POST /api/tunnels` is rate limited to 10 per 60s per user, and the
  // workload's own create step needs some of those. Seeding the full declared
  // fixture would consume the whole window and make the workload measure a 429
  // instead of the control plane -- and the limiter is a REAL production
  // control, so it is respected rather than bypassed. If the fixture cannot be
  // built inside the budget, that is a contract problem and it is reported.
  let created = 0;
  const createBudget = TUNNEL_CREATE_LIMIT - TUNNEL_CREATE_WORKLOAD_STEPS;
  if (want.tunnels > createBudget) {
    throw new Error(
      `the fixture declares ${want.tunnels} tunnels but POST /api/tunnels allows ${TUNNEL_CREATE_LIMIT} ` +
        `per 60s and the workload creates ${TUNNEL_CREATE_WORKLOAD_STEPS} of them, leaving ${createBudget}. ` +
        `Either lower the fixture or the create count; the rate limit will not be bypassed.`,
    );
  }
  for (let i = 0; i < want.tunnels; i += 1) {
    const response = await post("/api/tunnels", {
      name: `bench-seed-${i + 1}`,
      clientNodeId: nodes[i % nodes.length],
      serverNodeId: nodes[(i + 1) % nodes.length],
      autostart: false,
      // PORT_FORWARD for the same reason as the workload contract: DIRECT needs
      // a `gost` binary that is not vendored, so every create would 500.
      config: {
        method: "PORT_FORWARD",
        portForwards: [{
          name: `rule-seed-${i + 1}`,
          direction: "IRAN_TO_FOREIGN",
          protocol: "tcp",
          sourcePort: 18100 + i,
          destHost: "127.0.0.1",
          destPort: 9,
          enabled: true,
        }],
      },
    });
    if (response.ok) created += 1;
    else {
      const body = (await response.text()).slice(0, 160);
      console.log(`  fixture: tunnel ${i + 1} not created (HTTP ${response.status} ${body})`);
    }
  }
  return { nodes, tunnels: created };
}

/**
 * The server's own view of its memory, from /api/metrics.
 *
 * `rss` is the number a memory budget is set from: it includes the V8 heap, the
 * external buffers and the Prisma engine's native allocation, which
 * `heapUsed` alone understates by a wide margin on a Node server holding a
 * Prisma client. Null when the endpoint is unavailable, never 0.
 */
async function readServerMemory(origin: string, cookie: string): Promise<number | null> {
  try {
    const response = await fetch(`${origin}/api/metrics`, { headers: { cookie } });
    if (!response.ok) return null;
    const body = JSON.parse(await response.text()) as { memory?: { rss?: number } };
    const rss = body.memory?.rss;
    return typeof rss === "number" && Number.isFinite(rss) ? rss : null;
  } catch {
    return null;
  }
}

interface MetricsReading {
  /** process.memoryUsage().rss at the time the data was computed. */
  rss: number;
  /** Cumulative CPU microseconds, monotonic since process start. */
  cpuTotalMicros: number;
  /** When the payload was COMPUTED, not when the HTTP call happened. */
  generatedAt: string | null;
  /** Age of the cached payload at response time, or null if not reported. */
  cacheAgeMs: number | null;
}

/**
 * One /api/metrics reading with the cache state attached.
 *
 * The caller needs `cacheAgeMs` because the endpoint is deliberately cached and
 * rate-limited: a reading that is 19s old is a real value, but reporting it as
 * one of N samples makes a single observation look like a sampled series. Null
 * when unavailable, never 0 -- a zero here would be indistinguishable from a
 * genuinely idle process.
 */
async function readMetrics(origin: string, cookie: string): Promise<MetricsReading | null> {
  try {
    const response = await fetch(`${origin}/api/metrics`, { headers: { cookie } });
    if (!response.ok) return null;
    const body = JSON.parse(await response.text()) as {
      memory?: { rss?: number };
      cpu?: { totalMicros?: number };
      generatedAt?: string;
      cache?: { ageMs?: number | null };
    };
    const rss = body.memory?.rss;
    if (typeof rss !== "number" || !Number.isFinite(rss)) return null;
    const cpu = body.cpu?.totalMicros;
    return {
      rss,
      cpuTotalMicros: typeof cpu === "number" && Number.isFinite(cpu) ? cpu : 0,
      generatedAt: typeof body.generatedAt === "string" ? body.generatedAt : null,
      cacheAgeMs: typeof body.cache?.ageMs === "number" ? body.cache.ageMs : null,
    };
  } catch {
    return null;
  }
}

/** A numeric environment override, or the default when unset/invalid. */
function readNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Monotonic-ish delay. hrtime so a wall-clock step cannot make it negative. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const target = process.hrtime.bigint() + BigInt(Math.max(0, Math.round(ms))) * 1000_000n;
    const tick = (): void => {
      if (process.hrtime.bigint() >= target) resolve();
      else setTimeout(tick, Math.min(50, ms)).unref?.();
    };
    tick();
  });
}

async function timedRequest(
  origin: string,
  step: WorkloadStep,
  index: number,
  session: Session | undefined,
  context: TemplateContext,
): Promise<{ sample: Sample; createdTunnelId: string | null; bytes: number }> {
  const url = `${origin}${renderTemplate(step.path, context) as string}`;
  const init: RequestInit = { method: step.method, redirect: "manual" };
  const headers: Record<string, string> = {};
  if (session) headers.cookie = session.cookie;
  if (step.body) {
    headers["content-type"] = "application/json";
    headers.origin = origin;
    // The double-submit half of the CSRF check. Absent on writes, the server
    // rejects them before doing any work.
    if (session) headers["x-csrf-token"] = session.csrf;
    init.body = JSON.stringify(renderTemplate(step.body, context));
  }
  init.headers = headers;

  const started = nowMs();
  let status = 0;
  let bytes = 0;
  let text = "";
  let createdTunnelId: string | null = null;
  try {
    const response = await fetch(url, init);
    status = response.status;
    text = await response.text();
    bytes = Buffer.byteLength(text);
    if (step.method === "POST" && response.ok) {
      try {
        const parsed = JSON.parse(text) as { tunnel?: { id?: string }; id?: string };
        createdTunnelId = parsed.tunnel?.id ?? parsed.id ?? null;
      } catch { /* a non-JSON 2xx is still a successful request */ }
    }
  } catch (error) {
    status = 0;
    // A transport failure is a failed sample, not an exception that aborts the
    // run: the point of the benchmark is to record what happened.
    void error;
  }
  const durationMs = nowMs() - started;
  const ok = status >= 200 && status < 400;
  // The server redacts production errors to a short message, which is exactly
  // the part that identifies the cause. Never the request body.
  const error = ok
    ? undefined
    : `HTTP ${status}: ${text.replace(/\s+/g, " ").trim().slice(0, 160)}`
      + (init.body === undefined ? "" : ` | sent: ${String(init.body).replace(/\s+/g, " ").slice(0, 600)}`);
  return {
    sample: { step: step.id, index, status, durationMs, ok, ...(error === undefined ? {} : { error }) },
    createdTunnelId,
    bytes,
  };
}

interface Session {
  /** The full cookie header to send on every authenticated request. */
  readonly cookie: string;
  /** The `xt_csrf` value, for the x-csrf-token header on writes. */
  readonly csrf: string;
}

/**
 * Log in and keep BOTH halves of the session.
 *
 * The CSRF token is not optional decoration. `assertCsrf` is a double-submit
 * check: the `xt_csrf` cookie value must also be echoed in an `x-csrf-token`
 * header. A harness that sent only cookies got `403 CSRF token mismatch` on
 * every write, and the benchmark dutifully recorded a 0ms "fast rejection" as
 * if the control plane were quick -- which is how a benchmark measures its own
 * mistake.
 */
async function loginSession(origin: string): Promise<Session> {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
  });
  if (!response.ok) {
    throw new Error(`benchmark login failed with HTTP ${response.status}; the fixture user was not created`);
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  const pairs = cookies.map((sc) => sc.split(";")[0] as string).filter((p) => p.includes("="));
  const cookie = pairs.join("; ");
  if (!cookie) throw new Error("benchmark login set no cookie");
  const csrfPair = pairs.find((p) => p.slice(0, p.indexOf("=")) === "xt_csrf");
  if (!csrfPair) {
    throw new Error(
      `benchmark login set no xt_csrf cookie, so no state-changing request can be made. ` +
        `Cookies seen: ${pairs.map((p) => p.split("=")[0]).join(", ")}`,
    );
  }
  return { cookie, csrf: csrfPair.slice(csrfPair.indexOf("=") + 1) };
}

/** Resolve the payload to benchmark, refusing to silently test a different tree. */
function resolveArtifact(): string {
  // Order matters. `dist/artifact` is the real single-architecture release
  // payload and is what a target host should be measured on, but on a
  // non-target host it cannot boot at all -- and a harness that picked it first
  // would exit 77 on a developer's Windows machine while a perfectly good local
  // fixture sat unused next to it. The fixture is byte-identical apart from one
  // extra Prisma engine, and `artifact.isReleasePayload` records which was used.
  const override = process.env.XT_BENCH_ARTIFACT;
  const candidates = override
    ? [path.resolve(override)]
    : [path.join(REPO, "dist", "artifact-local"), path.join(REPO, "dist", "artifact")];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "apply-migrations.mjs"))) return candidate;
  }
  console.error(
    "No release payload found to benchmark.\n" +
      "Stage one first:\n" +
      "  npx tsx scripts/stage-real-artifact.ts          (the release payload)\n" +
      "  npx tsx scripts/stage-local-test-artifact.ts   (this host's engine)\n" +
      "or set XT_BENCH_ARTIFACT to a staged payload.",
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf("--out");
  const compareIdx = argv.indexOf("--compare");
  const labelIdx = argv.indexOf("--label");
  const outFile = outIdx >= 0 ? path.resolve(argv[outIdx + 1] as string) : null;
  const compareFile = compareIdx >= 0 ? path.resolve(argv[compareIdx + 1] as string) : null;
  const label = labelIdx >= 0 ? (argv[labelIdx + 1] as string) : "run";

  const artifact = resolveArtifact();

  console.log("=== xistance baseline benchmark ===");
  console.log(`label:        ${label}`);
  console.log(`artifact:     ${path.relative(REPO, artifact)}`);
  console.log(`workload:     ${WORKLOAD.digest} (${totalRequests(WORKLOAD)} control requests)`);
  console.log(`fixture:      ${WORKLOAD.fixture.nodes} nodes, ${WORKLOAD.fixture.tunnels} tunnels`);

  // ---- install phase, on its own -----------------------------------------
  const db = scratchDb("bench");
  const migrator = path.join(artifact, "apply-migrations.mjs");
  const admin = path.join(artifact, "create-admin.mjs");
  const dbUrl = `file:${db.replace(/\\/g, "/")}`;

  const installStart = nowMs();
  const migrate = spawnSync(process.execPath, [migrator, "--database", dbUrl], { encoding: "utf8" });
  const migrateMs = nowMs() - installStart;
  if (migrate.status !== 0) {
    throw new Error(`staged apply-migrations.mjs failed: ${(migrate.stderr || migrate.stdout || "").slice(-400)}`);
  }
  const adminStart = nowMs();
  const createAdmin = spawnSync(
    process.execPath,
    [admin, "--database", dbUrl, "--email", ADMIN_EMAIL, "--password", ADMIN_PASS],
    { encoding: "utf8" },
  );
  const adminMs = nowMs() - adminStart;
  if (createAdmin.status !== 0) {
    throw new Error(`staged create-admin.mjs failed: ${(createAdmin.stderr || createAdmin.stdout || "").slice(-400)}`);
  }
  const dbBytes = fs.existsSync(db) ? fs.statSync(db).size : 0;
  console.log(`install:      migrate ${migrateMs.toFixed(0)}ms, admin ${adminMs.toFixed(0)}ms`);

  // ---- startup phase, on its own -----------------------------------------
  const port = await freePort();
  const app: StagedAppHandle = await startStagedApp({
    standaloneRoot: artifact,
    db,
    port,
    adminEmail: ADMIN_EMAIL,
    adminPassword: ADMIN_PASS,
  });
  // startStagedApp already waited for a healthy answer; re-derive the two
  // milestones from the server's own readiness rather than inventing them.
  const firstHealthStart = nowMs();
  const health = await fetch(`${app.origin}/api/health`);
  const firstHealthMs = nowMs() - firstHealthStart;
  // 503 is a legitimate DEGRADED answer, so it is recorded rather than thrown
  // -- but a benchmark that timed a server reporting a broken database and
  // published the number as startup performance would be measuring a failure.
  if (health.status === 503) {
    throw new Error(
      `the panel answered /api/health with 503 (degraded) during the startup phase, so its ` +
        `response times describe a broken server, not the panel. Body: ${(await health.text()).slice(0, 300)}`,
    );
  }
  const session = await loginSession(app.origin);
  const firstAuthStart = nowMs();
  await fetch(`${app.origin}/api/tunnels`, { headers: { cookie: session.cookie } });
  const firstAuthMs = nowMs() - firstAuthStart;
  console.log(`startup:      first health ${firstHealthMs.toFixed(1)}ms, first authenticated ${firstAuthMs.toFixed(1)}ms`);

  // IDLE is measured here, while the server is up and nothing is being asked of
  // it, and BEFORE the control phase starts. Sampling only under load measures
  // the peak a busy panel needs, which is a different question from how much a
  // panel sitting on a small VPS actually occupies -- and the idle figure is the
  // one an operator sizes RAM from. It must be taken before the workload, because
  // once requests start arriving the process is no longer at rest.
  //
  // SAMPLING IS DELIBERATELY SPARSE. /api/metrics is served from a 20s cache and
  // rate-limited to 20 requests per 60s, and both are asserted production
  // controls (test-health-telemetry.ts), so this cannot be a 100ms poll. Polling
  // faster than the TTL would return the same cached object ten times and report
  // "stable across 10 samples" for what is one reading repeated -- a number that
  // is indistinguishable from a real, flat idle curve. Each sample is therefore
  // checked against cache.ageMs and a repeated cached value is reported as
  // CACHED rather than counted as another observation.
  const idleSamples: number[] = [];
  // The CPU rate divides by ELAPSED wall time, measured around the sampling loop.
  // It cannot be recomputed as (samples-1)*interval: samples that failed the
  // freshness check are dropped, so the count and the elapsed time stop
  // agreeing, and using the config value would silently misstate the window the
  // CPU figure actually covers.
  let idleSpanMs = 0;
  const cpuMarks: Array<{ micros: number; at: number }> = [];
  {
    const ttl = 20_000;
    const settleMs = Number(readNumberEnv("XT_BENCH_IDLE_SETTLE_MS", 2500));
    // Let lazy work finish: first-request compilation, JIT warm-up, the initial
    // reconciliation sweep. Measuring earlier reports a number that is only true
    // for a few hundred milliseconds.
    await sleep(settleMs);
    // /api/metrics allows 20 requests per 60s per user, and the control phase
    // also samples it once per request. The idle block therefore gets an
    // explicit, SMALL budget rather than a convenience default: a sampling plan
    // that quietly spends the quota the workload needs is not a measurement
    // problem, it is a run that will fail with 429 partway through and take the
    // whole benchmark with it. The prior failure mode was exactly that.
    const maxSamples = Number(readNumberEnv("XT_BENCH_IDLE_SAMPLES", 4));
    const samples = Math.max(2, Math.min(maxSamples, 6));
    if (maxSamples > 6) {
      console.log(
        `idle:         XT_BENCH_IDLE_SAMPLES=${maxSamples} clamped to ${samples}; the metrics ` +
          `endpoint allows 20 req/60s and the control phase needs most of that`,
      );
    }
    // Wider than the 20s TTL so successive samples are genuinely distinct
    // observations. Two CPUs would need 4 x 21s of settling; that cost is the
    // price of a number that means something.
    const intervalMs = Number(readNumberEnv("XT_BENCH_IDLE_INTERVAL_MS", 21_000));
    let duplicateReadings = 0;
    const sampleLoopStart = nowMs();
    // Dedupe on the IDENTITY of the computed payload, not on its age. cacheAgeMs
    // is measured when the response is served, so a cold cache reports ~0ms and
    // a warm one ~20s; both can be true for the SAME underlying computation. An
    // age threshold therefore accepts an arbitrary number of repeats of one
    // reading and rejects the first sample after a fresh compute -- the exact
    // inverse of correct. generatedAt is stamped when the data was COMPUTED, so
    // two samples sharing it are the same reading, whatever their age claims.
    const seen = new Set<string>();
    for (let i = 0; i < samples; i += 1) {
      const before = await readMetrics(app.origin, session.cookie);
      if (before !== null) {
        if (before.generatedAt === null) {
          // No compute timestamp: the payload cannot be identified, so it cannot
          // be counted as a distinct observation. Never assumed fresh.
          duplicateReadings += 1;
        } else if (seen.has(before.generatedAt)) {
          duplicateReadings += 1;
        } else {
          seen.add(before.generatedAt);
          idleSamples.push(before.rss);
          cpuMarks.push({ micros: before.cpuTotalMicros, at: nowMs() });
        }
      }
      if (i < samples - 1) await sleep(intervalMs);
    }
    idleSpanMs = nowMs() - sampleLoopStart;
    if (duplicateReadings > 0) {
      console.log(
        `idle:         ${duplicateReadings}/${samples} samples were cache hits and were NOT counted; ` +
          `poll faster than the ${ttl}ms TTL and you are reading one object repeatedly`,
      );
    }
  }
  const idleRss = idleSamples.length > 0 ? Math.max(...idleSamples) : null;
  // CPU rate needs two readings; a single cumulative total divided by uptime
  // would average the startup spike into the idle figure and understate it.
  //
  // Derived per CONSECUTIVE pair, not first-vs-last: the samples are 21s apart
  // and each one is a point in a curve. First-vs-last is the average over the
  // whole window, which is a different number from the rate an operator watches
  // on a panel that is up but idle. The worst pair is reported too, because an
  // average that hides one busy stretch is not an idle measurement.
  let idleCpuPercent: number | null = null;
  let idleCpuWorstPercent: number | null = null;
  for (let i = 1; i < cpuMarks.length; i += 1) {
    const prev = cpuMarks[i - 1]!;
    const cur = cpuMarks[i]!;
    const gapMs = cur.at - prev.at;
    // A gap of zero would divide by ~nothing and report thousands of percent,
    // so it is excluded rather than clamped -- a clamped value would look real.
    if (gapMs <= 0) continue;
    const rate = ((cur.micros - prev.micros) / 1000 / gapMs) * 100;
    if (idleCpuPercent === null) idleCpuPercent = rate;
    idleCpuWorstPercent = idleCpuWorstPercent === null ? rate : Math.max(idleCpuWorstPercent, rate);
  }
  console.log(
    `idle:         rss ${idleRss === null ? "unavailable" : (idleRss / 1048576).toFixed(1) + " MiB"} ` +
      `over ${idleSamples.length} samples, cpu ${idleCpuPercent === null ? "needs >=2 fresh samples" : idleCpuPercent.toFixed(2) + "% (worst pair " + (idleCpuWorstPercent === null ? "n/a" : idleCpuWorstPercent.toFixed(2) + "%") + ")"}`,
  );

  // Steady-state memory is read from the SERVER ITSELF via /api/metrics, which
  // already calls process.memoryUsage(). That is authoritative and costs one
  // request; sampling an external pid needs `tasklist`, which is a process
  // spawn per sample and far too slow for a 100ms interval -- and when its
  // output parsing failed it produced a confident 0.
  //
  // Startup memory still needs the external reader, because before the first
  // request there is no endpoint to ask. That peak is what a low-RAM host is
  // most likely to fail on.
  let steadyStatePeakRss = 0;
  let steadyStateSamples = 0;

  // ---- control phase ------------------------------------------------------
  const control = WORKLOAD.phases.find((p) => p.phase === "control");
  if (!control) throw new Error("the workload contract has no control phase");
  const stepSummaries: StepSummary[] = [];
  const controlStart = nowMs();
  // A tunnel id for the steps that need one. Starts empty: if the create step
  // fails, the dependent step must be reported as unmeasurable rather than
  // silently timing a 404 and reporting it as a fast response.
  //
  // Ports for the workload's creates, allocated as COMPLETE values and range-
  // checked before use. Three earlier attempts all failed the same way: a fixed
  // port collided (409), and both prefix-concatenation schemes ("182"+token,
  // "182"+base+token) produced 182134/18218300 -- six digits, past 65535, so
  // every create 422'd on the one field under test. The lesson is that a port
  // should be validated in the same place it is chosen, not inferred from string
  // arithmetic in two files.
  //
  // The base avoids the fixture's 18100.. range and the ephemeral range on
  // loopback. The offset comes from a coarse wall clock so two runs minutes
  // apart do not collide on ports the previous run's tunnels still hold. Wall
  // clock, not the monotonic clock: monotonic time starts at process launch, so
  // two runs started in the same second are near-identical and would collide
  // anyway. Deliberately NOT random -- a random base makes the benchmark
  // irreproducible, and reproducibility is the entire point of a baseline. The
  // range is recorded in the result so a run's ports stay auditable.
  const PORT_BASE = 19000;
  const PORT_SPAN = 400;
  const portFor = (index: number): number => {
    const port = PORT_BASE + ((Math.floor(Date.now() / 1000) % PORT_SPAN) + index);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`allocated source port ${port} is out of range; it must be 1..65535`);
    }
    return port;
  };
  const fixtureStart = nowMs();
  const fixture = await seedFixture(app.origin, session);
  const fixtureMs = nowMs() - fixtureStart;
  console.log(
    `fixture:      ${fixture.nodes.length} nodes, ${fixture.tunnels}/${WORKLOAD.fixture.tunnels} tunnels ` +
      `(${fixtureMs.toFixed(0)}ms, not counted in any phase)`,
  );
  let context = {
    nonce: randomBytes(4).toString("hex"),
    tunnelId: "",
    clientNodeId: fixture.nodes[0],
    serverNodeId: fixture.nodes[1 % fixture.nodes.length],
  };
  const createdIds: string[] = [];
  for (const step of control.steps) {
    // A step that needs a resource produced by an earlier step must not run
    // against a placeholder: it would measure a 404, and "0ms 404" is the most
    // flattering possible number in a latency table.
    if (step.path.includes("{{tunnelId}}") && context.tunnelId === "") {
      console.log(`  ${step.id.padEnd(20)} SKIPPED: no tunnel was created, so there is nothing to diagnose`);
      stepSummaries.push({
        id: step.id,
        method: step.method,
        path: step.path,
        count: 0,
        okCount: 0,
        statuses: {},
        errors: { "not measured: the create step produced no tunnel": 1 },
        minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0, bytes: 0,
      });
      continue;
    }
    const samples: Sample[] = [];
    let bytes = 0;
    for (let i = 0; i < step.count; i += 1) {
      // The complete port for this create, validated above. The contract takes
      // the whole value, so no prefix arithmetic can turn it out of range here.
      const requestContext: TemplateContext = { ...context, sourcePort: String(portFor(i)) };
      const { sample, createdTunnelId, bytes: responseBytes } = await timedRequest(
        app.origin, step, i, step.authenticated ? session : undefined, requestContext,
      );
      samples.push(sample);
      bytes += responseBytes;
      // A created tunnel becomes the target for the diagnostics read, so that
      // step measures a real aggregation instead of a 404.
      if (createdTunnelId) {
        context = { ...context, tunnelId: createdTunnelId };
        createdIds.push(createdTunnelId);
      }
    }
    // Sample the server's memory as part of the workload, so the steady-state
    // peak is a real observation during load rather than a single reading
    // before or after it.
    const observed = await readServerMemory(app.origin, session.cookie);
    if (observed !== null) {
      steadyStateSamples += 1;
      if (observed > steadyStatePeakRss) steadyStatePeakRss = observed;
    }
    const summary = summarise(step, samples, bytes);
    stepSummaries.push(summary);
    console.log(
      `  ${step.id.padEnd(20)} n=${String(summary.count).padStart(3)} ok=${String(summary.okCount).padStart(3)} ` +
      `p50=${summary.p50Ms.toFixed(1)}ms p95=${summary.p95Ms.toFixed(1)}ms max=${summary.maxMs.toFixed(1)}ms`,
    );
  }
  const controlMs = nowMs() - controlStart;

  // ---- reconnect phase ----------------------------------------------------
  // Runs AFTER the control phase, because it needs the tunnel that phase's
  // create step produced. Measured here rather than as a fourth control step so
  // a recovery number is never averaged into the steady-state latency table:
  // recovery is dominated by engine work, and folding it into "control" would
  // make a healthy panel look slow.
  const reconnect = WORKLOAD.phases.find((p) => p.phase === "reconnect");
  const reconnectSummaries: StepSummary[] = [];
  let reconnectMs = 0;
  if (reconnect) {
    if (context.tunnelId === "") {
      // Same rule as the diagnostics step: no tunnel means no recovery to
      // measure, and a 0ms entry here would be indistinguishable from a fast
      // recovery in the result.
      for (const step of reconnect.steps) {
        reconnectSummaries.push({
          id: step.id, method: step.method, path: step.path, count: 0, okCount: 0,
          statuses: {}, errors: { "not measured: no tunnel exists to recover": 1 },
          minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0, bytes: 0,
        });
      }
      console.log("reconnect:    SKIPPED: no tunnel was created, so there is nothing to recover");
    } else {
      const reconnectStart = nowMs();
      for (const step of reconnect.steps) {
        const samples: Sample[] = [];
        let bytes = 0;
        for (let i = 0; i < step.count; i += 1) {
          const { sample, bytes: responseBytes } = await timedRequest(
            app.origin, step, i, step.authenticated ? session : undefined, context,
          );
          samples.push(sample);
          bytes += responseBytes;
        }
        const summary = summarise(step, samples, bytes);
        reconnectSummaries.push(summary);
        console.log(
          `  ${step.id.padEnd(20)} n=${String(summary.count).padStart(3)} ok=${String(summary.okCount).padStart(3)} ` +
          `p50=${summary.p50Ms.toFixed(1)}ms ${JSON.stringify(summary.statuses)}`,
        );
      }
      reconnectMs = nowMs() - reconnectStart;
    }
  }

  // One final self-report, so the steady-state peak is not left to whatever the
  // last control request happened to leave behind.
  const finalMemory = await readServerMemory(app.origin, session.cookie);
  if (finalMemory !== null) {
    steadyStateSamples += 1;
    if (finalMemory > steadyStatePeakRss) steadyStatePeakRss = finalMemory;
  }
  await app.stop();
  // Read AFTER stop: the getters are populated by stop() itself, so sampling
  // before it would always report null and look like an unmeasured shutdown.
  const shutdownMs = app.shutdownMs;
  const shutdownForced = app.shutdownForced;
  if (shutdownMs !== null) {
    console.log(
      `shutdown:     ${shutdownMs.toFixed(1)}ms${shutdownForced ? " (SIGKILL after 5s grace -- not a clean exit)" : ""}`,
    );
  } else {
    console.log("shutdown:     not measured (the process had already exited)");
  }

  // ---- result -------------------------------------------------------------
  const phases: PhaseSummary[] = [
    {
      phase: "install",
      description: WORKLOAD.phases.find((p) => p.phase === "install")?.description ?? "",
      steps: [],
      durationMs: Number((migrateMs + adminMs).toFixed(3)),
      requests: 0,
    },
    {
      phase: "startup",
      description: WORKLOAD.phases.find((p) => p.phase === "startup")?.description ?? "",
      steps: [],
      durationMs: Number((firstHealthMs + firstAuthMs).toFixed(3)),
      requests: 2,
    },
    {
      phase: "control",
      description: control.description,
      steps: stepSummaries,
      durationMs: Number(controlMs.toFixed(3)),
      requests: totalRequests(WORKLOAD),
    },
  ];
  if (reconnect) {
    phases.push({
      phase: "reconnect",
      description: reconnect.description,
      steps: reconnectSummaries,
      durationMs: Number(reconnectMs.toFixed(3)),
      requests: reconnect.steps.reduce((n, s) => n + s.count, 0),
    });
  }

  const result: Record<string, unknown> = {
    schema: SCHEMA,
    label,
    workload: {
      digest: WORKLOAD.digest,
      schema: WORKLOAD.schema,
      controlRequests: totalRequests(WORKLOAD),
      fixture: WORKLOAD.fixture,
      phases: WORKLOAD.phases.map((p) => ({
        phase: p.phase,
        description: p.description,
        steps: p.steps.map((s) => ({ id: s.id, method: s.method, path: s.path, count: s.count })),
      })),
    },
    host: {
      ...hostInfo(),
      // A different host makes a comparison meaningless, so the identity that
      // decides comparability is recorded explicitly.
      comparable: `${os.platform()}-${os.arch()}-${os.cpus().length}vcpu`,
    },
    artifact: {
      path: path.relative(REPO, artifact),
      sizeBytes: directoryBytes(artifact),
      // Whether this is the real single-architecture payload or a local fixture
      // with an extra engine. A benchmark on the fixture is still a benchmark,
      // but it is not the release payload and the result says so.
      isReleasePayload: !path.basename(artifact).endsWith("-local"),
    },
    install: {
      migrationsMs: Number(migrateMs.toFixed(3)),
      adminBootstrapMs: Number(adminMs.toFixed(3)),
      databaseBytes: dbBytes,
      // Seeding goes through the real API, so it is setup cost, not workload.
      // Reported separately rather than folded into install: an operator never
      // does this, and adding it to install would overstate the real cost.
      fixtureSeedMs: Number(fixtureMs.toFixed(3)),
      fixtureNodes: fixture.nodes.length,
      fixtureTunnels: fixture.tunnels,
      workloadPortBase: portFor(0),
    },
    startup: {
      firstHealthResponseMs: Number(firstHealthMs.toFixed(3)),
      firstAuthenticatedResponseMs: Number(firstAuthMs.toFixed(3)),
    },
    // Idle is separated from the two peaks above because it answers a different
    // question: not "what is the worst moment" but "what does a panel that is up
    // and not being used occupy". An operator sizing a small VPS needs the idle
    // figure; the peaks are what it must survive.
    idle: {
      rssBytes: idleRss,
      cpuPercent: idleCpuPercent === null ? null : Number(idleCpuPercent.toFixed(3)),
      // The busiest consecutive pair, and the span the rate was measured over.
      // A mean that hides one busy stretch is not an idle measurement.
      cpuWorstPairPercent: idleCpuWorstPercent === null ? null : Number(idleCpuWorstPercent.toFixed(3)),
      elapsedMs: Number(idleSpanMs.toFixed(3)),
      samples: idleSamples.length,
      // Polling faster than the endpoint's 20s cache TTL returns the same object
      // repeatedly. Recording the intended interval alongside the count lets a
      // reader tell a flat idle curve from one frozen reading counted N times.
      intendedIntervalMs: Number(readNumberEnv("XT_BENCH_IDLE_INTERVAL_MS", 21_000)),
      settledMs: Number(readNumberEnv("XT_BENCH_IDLE_SETTLE_MS", 2500)),
      // /api/metrics is cached and rate-limited by design, so a sample is only
      // counted when it is genuinely fresh. The source of the CPU rate.
      source: "server process.memoryUsage()/cpuUsage() via /api/metrics, cache-age filtered",
      notMeasured:
        idleSamples.length >= 2
          ? []
          : ["idle CPU rate needs two fresh samples; a single cumulative total over uptime would " +
             "average the startup spike into the idle figure and understate it"],
    },
    shutdown: {
      durationMs: shutdownMs === null ? null : Number(shutdownMs.toFixed(3)),
      // A clean exit and one that only happened because it was killed are the
      // same duration to a naive average and completely different to an operator.
      forced: shutdownForced,
      graceMs: 5000,
    },
    memory: {
      // Two peaks, because a low-RAM host fails at whichever is larger. The
      // startup burst is largely reclaimed by the time the control phase runs,
      // so a steady-state-only figure would understate the requirement.
      startupPeakRssBytes: app.startupPeakRssBytes,
      startupMemorySamples: app.startupMemorySamples,
      steadyStatePeakRssBytes: steadyStatePeakRss,
      steadyStateSamples,
      // How each figure was obtained, because they are NOT equivalent: the
      // startup peak is read from the OS for a pid, the steady-state figure is
      // the server reporting on itself. Neither is a substitute for the other.
      source: { startup: "OS RSS for the server pid", steadyState: "server process.memoryUsage() via /api/metrics" },
      // The worst moment, which is the number a RAM budget should be set from.
      peakRssBytes: Math.max(app.startupPeakRssBytes, steadyStatePeakRss),
    },
    phases,
    // Explicit so a reader never has to infer that a figure is absent. Tunnels
    // were stopped and started, so "reconnect behaviour" is measured -- but only
    // the panel's CONTROL-PLANE recovery (honour the stop, report it, restart).
    // Re-establishing a live transport between two real peers is a different
    // measurement needing real nodes and a network path, so it stays listed.
    notMeasured: [
      "tunnel throughput",
      "bandwidth",
      "live transport re-establishment between real peers (only control-plane stop/status/start recovery is measured)",
    ],
    generatedAt: new Date().toISOString(),
  };

  assertNoUnmeasuredClaims(result);

  // A benchmark that reports a table with silent holes is worse than one that
  // stops: the reader sees p50s and assumes every row was measured. Fail loudly
  // unless --allow-incomplete is passed, which is for diagnosing a broken
  // environment, never for producing a release number.
  const incomplete = stepSummaries.filter((st) => st.count === 0 || st.okCount < st.count);
  if (incomplete.length > 0 && !argv.includes("--allow-incomplete")) {
    console.error("\nThe workload did not complete. Refusing to publish a partial benchmark:");
    for (const st of incomplete) {
      const why = Object.keys(st.errors).join("; ") || `only ${st.okCount}/${st.count} succeeded`;
      console.error(`  - ${st.id}: ${why}`);
    }
    console.error("\nRe-run with --allow-incomplete to capture diagnostics of a broken environment.");
    console.error("A partial result must not be used as a baseline or a comparison.");
    // The server is already stopped by this point in the run; only the scratch
    // database needs clearing.
    fs.rmSync(path.dirname(db), { recursive: true, force: true });
    process.exit(1);
  }

  const serialised = `${JSON.stringify(result, null, 2)}\n`;
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, serialised, "utf8");
    console.log(`\nwrote ${path.relative(REPO, outFile)}`);
  } else {
    console.log("");
    console.log(serialised);
  }

  if (compareFile) {
    const baseline = JSON.parse(fs.readFileSync(compareFile, "utf8")) as Record<string, unknown>;
    const comparison = compare(baseline, result);
    console.log("\n=== comparison vs baseline ===");
    for (const line of comparison.lines) console.log(`  ${line}`);
    if (!comparison.comparable) {
      console.error("\nNOT COMPARABLE: the runs differ in host or workload.");
      process.exit(1);
    }
  }

  fs.rmSync(path.dirname(db), { recursive: true, force: true });
}

interface Comparison {
  comparable: boolean;
  reasons: string[];
  lines: string[];
}

function pctChange(base: number, next: number): string {
  if (base === 0) return next === 0 ? "unchanged" : "n/a (baseline was 0)";
  const change = ((next - base) / base) * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(1)}%`;
}

function compare(baseline: Record<string, unknown>, candidate: Record<string, unknown>): Comparison {
  const reasons: string[] = [];
  const bHost = baseline.host as Record<string, unknown> | undefined;
  const cHost = candidate.host as Record<string, unknown> | undefined;
  if (bHost?.comparable !== cHost?.comparable) {
    reasons.push(`host differs: ${String(bHost?.comparable)} vs ${String(cHost?.comparable)}`);
  }
  const bDigest = (baseline.workload as Record<string, unknown> | undefined)?.digest;
  const cDigest = (candidate.workload as Record<string, unknown> | undefined)?.digest;
  if (bDigest !== cDigest) {
    reasons.push(`workload differs: ${String(bDigest)} vs ${String(cDigest)}`);
  }
  const lines: string[] = [];
  if (reasons.length > 0) return { comparable: false, reasons, lines };

  const bInstall = baseline.install as Record<string, number>;
  const cInstall = candidate.install as Record<string, number>;
  lines.push(`migrations      ${bInstall.migrationsMs.toFixed(0)}ms -> ${cInstall.migrationsMs.toFixed(0)}ms  ${pctChange(bInstall.migrationsMs, cInstall.migrationsMs)}`);
  lines.push(`admin bootstrap ${bInstall.adminBootstrapMs.toFixed(0)}ms -> ${cInstall.adminBootstrapMs.toFixed(0)}ms  ${pctChange(bInstall.adminBootstrapMs, cInstall.adminBootstrapMs)}`);

  const bStartup = baseline.startup as Record<string, number>;
  const cStartup = candidate.startup as Record<string, number>;
  lines.push(`first health    ${bStartup.firstHealthResponseMs.toFixed(1)}ms -> ${cStartup.firstHealthResponseMs.toFixed(1)}ms  ${pctChange(bStartup.firstHealthResponseMs, cStartup.firstHealthResponseMs)}`);
  lines.push(`first auth      ${bStartup.firstAuthenticatedResponseMs.toFixed(1)}ms -> ${cStartup.firstAuthenticatedResponseMs.toFixed(1)}ms  ${pctChange(bStartup.firstAuthenticatedResponseMs, cStartup.firstAuthenticatedResponseMs)}`);

  const bMem = baseline.memory as Record<string, number>;
  const cMem = candidate.memory as Record<string, number>;
  lines.push(`peak RSS        ${(bMem.peakRssBytes / 2 ** 20).toFixed(1)} MiB -> ${(cMem.peakRssBytes / 2 ** 20).toFixed(1)} MiB  ${pctChange(bMem.peakRssBytes, cMem.peakRssBytes)}`);
  lines.push(`  startup peak  ${((bMem.startupPeakRssBytes ?? 0) / 2 ** 20).toFixed(1)} MiB -> ${((cMem.startupPeakRssBytes ?? 0) / 2 ** 20).toFixed(1)} MiB  ${pctChange(bMem.startupPeakRssBytes ?? 0, cMem.startupPeakRssBytes ?? 0)}`);
  lines.push(`  steady peak   ${((bMem.steadyStatePeakRssBytes ?? 0) / 2 ** 20).toFixed(1)} MiB -> ${((cMem.steadyStatePeakRssBytes ?? 0) / 2 ** 20).toFixed(1)} MiB  ${pctChange(bMem.steadyStatePeakRssBytes ?? 0, cMem.steadyStatePeakRssBytes ?? 0)}`);

  const bSteps = new Map<string, StepSummary>();
  for (const phase of baseline.phases as PhaseSummary[]) {
    for (const step of phase.steps) bSteps.set(step.id, step);
  }
  for (const phase of candidate.phases as PhaseSummary[]) {
    for (const step of phase.steps) {
      const before = bSteps.get(step.id);
      if (!before) {
        lines.push(`${step.id.padEnd(20)} NEW in candidate (p50 ${step.p50Ms.toFixed(1)}ms)`);
        continue;
      }
      lines.push(`${step.id.padEnd(20)} p50 ${before.p50Ms.toFixed(1)} -> ${step.p50Ms.toFixed(1)}ms ${pctChange(before.p50Ms, step.p50Ms)}   p95 ${before.p95Ms.toFixed(1)} -> ${step.p95Ms.toFixed(1)}ms ${pctChange(before.p95Ms, step.p95Ms)}`);
    }
  }
  return { comparable: true, reasons, lines };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
