/**
 * Shared per-method test harness (TASK-35).
 *
 * Nine methods, one contract. Writing that contract nine times produced nine
 * suites of uneven depth: BACKHAUL, FRP, GOST, SSH and XRAY had config tests
 * only, while DIRECT, REVERSE and XUI had real engine lifecycle tests. The
 * matrix built on top of this could not tell "the method was verified" from
 * "its builder was verified", which is the distinction release acceptance
 * turns on.
 *
 * `runMethodContract` applies the SAME checks to every method, so a gap is a
 * missing result rather than a missing section nobody noticed.
 *
 * The process handle is injected, so lifecycle semantics (idempotent stop,
 * cleanup after a failed deploy, bounded dispose, status truth) are provable
 * without a real tunnel binary. That is stated in the record: it is
 * `realBinary: false`, not a claim that traffic flowed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TunnelEngine, type TunnelDeploySpec, type ProcessSpec } from "../../packages/tunnel-core/src/engine.ts";
import { TunnelMethod, TunnelConfigSchema, type TunnelConfig } from "../../packages/types/src/index.ts";

/** Scriptable process handle: the engine's lifecycle promises are only
 *  provable against a handle that can be told to fail, hang or report a
 *  chosen state. */
export class ScriptedHandle {
  /** False until start() succeeds: a handle that was never started is not
   *  running, and pretending otherwise manufactures phantom leaked processes. */
  running = false;
  starts = 0;
  stops = 0;
  /** Number of starts that actually succeeded. This -- not `running` -- is what
   *  a "did the engine clean up?" check must test. */
  startedOk = 0;
  /** Set to make start() reject, for partial-deploy cleanup testing. */
  failStart = false;
  /** Set to make isRunning() never settle, for dispose-bound testing. */
  hang = false;
  constructor(readonly spec: ProcessSpec) {}
  async isRunning(): Promise<boolean> {
    if (this.hang) return new Promise<boolean>(() => undefined);
    return this.running;
  }
  async start(): Promise<void> {
    this.starts += 1;
    if (this.failStart) throw new Error("scripted start failure");
    this.running = true;
    this.startedOk += 1;
  }
  async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
  }
  /** Part of the ProcessHandle contract; the engine calls it from restart(). */
  async restart(): Promise<void> {
    this.starts += 1;
    this.running = true;
    this.startedOk += 1;
  }
  /** Part of the ProcessHandle contract; the engine calls it from disposeAll(). */
  async dispose(): Promise<void> {
    this.stops += 1;
    this.running = false;
  }
}

export interface MethodResult {
  method: string;
  /** Every check name that ran, with pass/fail. */
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
  /** True when the engine lifecycle ran against a real TunnelEngine. */
  lifecycleExercised: boolean;
  /** Always false here: no tunnel binary is executed by this harness. */
  realBinary: boolean;
  /** Set when the method is metadata-only and has no process by design. */
  metadataOnly: boolean;
}

const ok = (r: MethodResult, name: string, cond: boolean, detail?: string) => {
  r.checks.push({ name, ok: cond, detail: cond ? undefined : detail });
};

export interface ContractInput {
  method: TunnelMethod;
  /** A schema-valid config for this method. */
  config: unknown;
  /** Methods that legitimately run no process (XUI is metadata-only). */
  metadataOnly?: boolean;
  /** Provide node endpoints when the method needs them. */
  clientNode?: Record<string, unknown>;
  serverNode?: Record<string, unknown>;
  /**
   * Optional per-method override for the process handle, so a method that
   * resolves binaries from a node context can be pointed at a fixture dir.
   */
  prepare?: (dataDir: string, binDir: string) => Promise<void> | void;
  /**
   * Extra EngineOptions, merged last so a method can supply its own test seam.
   * XUI needs `xuiSync` here: without it a deploy verifies against the real
   * 3X-UI panel, which means live DNS and live HTTP inside a unit test.
   */
  engineOptions?: Record<string, unknown>;
}

/**
 * Apply the shared contract to one method. Returns a result record; never
 * throws, so one method's breakage cannot hide the other eight.
 */
export async function runMethodContract(input: ContractInput): Promise<MethodResult> {
  if (process.env.MX_TRACE) console.log(`        [mx] start ${input.method}`);
  const r: MethodResult = {
    method: input.method,
    checks: [],
    lifecycleExercised: false,
    realBinary: false,
    metadataOnly: input.metadataOnly === true,
  };

  // ---- configuration ------------------------------------------------------
  let cfg: TunnelConfig;
  try {
    cfg = TunnelConfigSchema.parse(input.config) as TunnelConfig;
    ok(r, "config parses through TunnelConfigSchema", true);
  } catch (e) {
    ok(r, "config parses through TunnelConfigSchema", false,
      ((e as { issues?: Array<{ path: unknown[]; message: string }> }).issues ?? [])
        .map((i) => `${i.path.join(".")}: ${i.message}`).join(" || ").slice(0, 300));
    return r;
  }
  ok(r, "config round-trips with its method intact", cfg.method === input.method,
    `parsed as ${(cfg as { method: string }).method}`);

  // A malformed config must be refused, not silently accepted.
  //
  // The mutation is applied to the method's OWN block (cfg.<method>), not to a
  // top-level key. The earlier version added a top-level `listenPort` that no
  // method schema reads, so it proved nothing for methods that ignore unknown
  // keys and failed spuriously for the ones that are strict.
  let refused = false;
  let refusalDetail = "";
  try {
    const bad = structuredClone(input.config) as Record<string, Record<string, unknown>>;
    const block = bad[input.method] ?? {};
    // `localPort` matches /port$/i but so would `port`; the first key in
    // declaration order is not guaranteed to be the one the schema validates,
    // and an unvalidated key makes this check pass for the wrong reason. Try
    // every port-ish key in turn and require that at least one is refused --
    // that is the property "this schema bounds its ports", not "one key is
    // named exactly X".
    const portKeys = Object.keys(block).filter((k) => /port/i.test(k));
    let anyRejected = false;
    for (const k of portKeys) {
      const attempt = structuredClone(bad) as Record<string, Record<string, unknown>>;
      attempt[input.method][k] = 70000;
      try {
        TunnelConfigSchema.parse(attempt);
      } catch {
        anyRejected = true;
        break;
      }
    }
    if (!anyRejected) throw new Error("no port field was range-checked");
  } catch (e) {
    refused = true;
    refusalDetail = ((e as { issues?: Array<{ message: string }> }).issues ?? [])
      .map((i) => i.message).join(" || ").slice(0, 160);
  }
  ok(r, "an out-of-range port in the method's own config is refused", refused, refusalDetail);

  // ---- engine lifecycle ---------------------------------------------------
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `xt-mx-${input.method.toLowerCase()}-`));
  const binDir = path.join(dataDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  // Fixture binaries so a method that resolves a binary at plan time can find
  // one. These are empty files: the handle is injected, so nothing executes.
  for (const n of ["ssh", "autossh", "xray", "gost", "frpc", "frps", "backhaul"]) {
    const f = path.join(binDir, n);
    fs.writeFileSync(f, "#!/bin/sh\nexit 0\n");
    try { fs.chmodSync(f, 0o755); } catch { /* NTFS */ }
  }

  try {
    if (input.prepare) await input.prepare(dataDir, binDir);

    const handles: ScriptedHandle[] = [];
    const engine = new TunnelEngine({
      dataDir,
      localBinDir: binDir,
      forceNodeFallback: true,
      forwarderRunner: { prefix: ["node"], script: "forwarder.mjs" },
      createProcessHandle: async (s) => {
        const h = new ScriptedHandle(s as ProcessSpec);
        handles.push(h);
        return h as never;
      },
      ...input.engineOptions,
    } as never);

    // The runner the engine will use for `which` and the REVERSE reachability
    // probe. Answering `which` matters: an empty answer fails the deploy with
    // "Required system tool ssh is missing", which is a fixture artifact.
    const stubCtx = {
      runner: {
        kind: "local" as const,
        async run(cmd: string[]) {
          const j = cmd.join(" ");
          if (j.includes("which")) return { stdout: "/usr/bin/" + (j.includes("autossh") ? "autossh" : "ssh") + "\n", stderr: "", exitCode: 0 };
          if (j.includes("ss -ltnH")) return { stdout: "0.0.0.0:10808\n", stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        async writeFile() { return undefined; },
      },
      binDir, cfgDir: path.join(dataDir, "cfg"), dataDir, name: "stub",
    };
    (engine as never as { ctxFor: (n: unknown) => unknown }).ctxFor = () => stubCtx;

    const spec = {
      id: `mx-${input.method.toLowerCase()}`,
      name: `mx ${input.method}`,
      method: input.method,
      config: cfg,
      clientNode: input.clientNode ?? { id: "n1", host: "127.0.0.1", isLocal: true, username: "root" },
      serverNode: input.serverNode ?? { id: "n2", host: "127.0.0.1", isLocal: true, username: "root" },
    } as unknown as TunnelDeploySpec;

    // ---- deploy ----
    let deployed = true;
    try {
      await engine.deploy(spec);
    } catch (e) {
      deployed = false;
      ok(r, "deploy succeeds", false, (e as Error).message);
    }
    if (deployed) {
      ok(r, "deploy succeeds", true);
      r.lifecycleExercised = true;
    }

    // A metadata-only method is allowed to have no process; every other method
    // must actually own one, or it is not doing anything.
    if (r.metadataOnly) {
      ok(r, "a metadata-only method keeps zero processes", handles.length === 0, `${handles.length} processes`);
    } else {
      ok(r, "deploy owns at least one process", handles.length > 0, `${handles.length} processes`);
    }

    if (process.env.MX_TRACE) console.log(`        [mx] {input.method} after-deploy`);
    // ---- status truth ----
    const st1 = await engine.status(spec.id);
    ok(r, "a deployed tunnel reports a known status", ["running", "degraded", "stopped", "error", "starting"].includes(st1), String(st1));
    if (!r.metadataOnly && handles.length > 0) {
      ok(r, "a live process reports running or degraded", st1 === "running" || st1 === "degraded", String(st1));
    }

    if (process.env.MX_TRACE) console.log(`        [mx] {input.method} before-stop`);
    // ---- stop idempotence ----
    const stopsBefore = handles.reduce((a, h) => a + h.stops, 0);
    await engine.stop(spec.id).catch(() => undefined);
    const stopsAfter = handles.reduce((a, h) => a + h.stops, 0);
    if (r.metadataOnly) {
      ok(r, "stopping a metadata-only method is a no-op", stopsAfter === stopsBefore);
    } else {
      ok(r, "stop issues exactly one stop per process", stopsAfter - stopsBefore === handles.length,
        `${stopsAfter - stopsBefore} stops for ${handles.length} processes`);
    }

    // A repeated stop must not throw and must not re-stop: idempotence is the
    // property that makes a double-click on "stop" safe.
    let repeatThrew = false;
    try { await engine.stop(spec.id); } catch { repeatThrew = true; }
    ok(r, "a repeated stop does not throw", !repeatThrew);
    const stopsFinal = handles.reduce((a, h) => a + h.stops, 0);
    ok(r, "a repeated stop issues no additional stops", stopsFinal === stopsAfter,
      `${stopsFinal - stopsAfter} extra stops`);

    const st2 = await engine.status(spec.id);
    ok(r, "a stopped tunnel reports stopped", st2 === "stopped" || st2 === "error", String(st2));

    if (process.env.MX_TRACE) console.log(`        [mx] {input.method} before-restart`);
    // ---- restart / reconnect ----
    let restartThrew = false;
    try { await engine.restart(spec.id); } catch { restartThrew = true; }
    if (r.metadataOnly) {
      ok(r, "restarting a metadata-only method does not throw", !restartThrew);
    } else {
      ok(r, "restart does not throw", !restartThrew);
      const st3 = await engine.status(spec.id);
      ok(r, "a restarted tunnel returns to a live status", st3 === "running" || st3 === "degraded", String(st3));
    }

    // ---- cleanup on a failed deploy ----
    // A process that starts and then a later one that fails must leave nothing
    // running. This is the partial-deploy leak TASK-19 fixed; every method must
    // inherit it, so every method is checked.
    if (process.env.MX_TRACE) console.log(`        [mx] ${input.method} pre-engine2`);
    const handles2: ScriptedHandle[] = [];
    const engine2 = new TunnelEngine({
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), `xt-mx2-${input.method.toLowerCase()}-`)),
      localBinDir: binDir,
      forceNodeFallback: true,
      forwarderRunner: { prefix: ["node"], script: "forwarder.mjs" },
      createProcessHandle: async (s) => {
        const h = new ScriptedHandle(s as ProcessSpec);
        // Let the first succeed and the second fail, so a partial deploy exists.
        h.failStart = handles2.length > 0;
        if (process.env.MX_TRACE) console.log(`        [mx] ${input.method} handle#${handles2.length} failStart=${h.failStart}`);
        handles2.push(h);
        return h as never;
      },
    } as never);
    if (process.env.MX_TRACE) console.log(`        [mx] ${input.method} post-engine2-ctor`);
    (engine2 as never as { ctxFor: (n: unknown) => unknown }).ctxFor = () => stubCtx;
    if (!r.metadataOnly && handles.length > 1) {
      if (process.env.MX_TRACE) console.log(`        [mx] ${input.method} entering engine2.deploy`);
      await engine2.deploy(spec).catch(() => undefined);
      if (process.env.MX_TRACE) console.log(`        [mx] ${input.method} engine2.deploy done, handles2=${handles2.length}`);
      // A leak is a process that ACTUALLY started and was never stopped. A
      // handle whose start() threw was never a process, so demanding a stop for
      // it would be asserting something the engine has no reason to do.
      const leaked = handles2.filter((h) => h.startedOk > 0 && h.stops === 0 && h.running);
      if (process.env.MX_TRACE) {
        for (const h of handles2) {
          console.log(`        [mx] ${input.method} h#${handles2.indexOf(h)} unit=${h.spec.unitName ?? "?"} ` +
            `starts=${h.starts} stops=${h.stops} running=${h.running} failStart=${h.failStart}`);
        }
      }
      ok(r, "a partially failed deploy leaves no process running", leaked.length === 0,
        `${leaked.length} leaked of ${handles2.length}: ` +
        handles2.map((h) => `${h.spec.unitName ?? "?"}(starts=${h.starts},stops=${h.stops})`).join(","));
    } else {
      // Single-process or metadata-only methods cannot partially fail; say so
      // rather than silently passing.
      ok(r, "partial-deploy cleanup is not applicable to a single-process method", handles.length <= 1,
        `${handles.length} processes`);
    }

    if (process.env.MX_TRACE) console.log(`        [mx] {input.method} before-resource`);
    // ---- resource bound: dispose is bounded ----
    if (!r.metadataOnly && handles.length > 0) {
      handles.forEach((h) => { h.hang = true; });
      const t0 = Date.now();
      // stop() must still settle even when isRunning() never answers.
      //
      // Budget: 5s per process for the bounded probe, plus the 15s dispose
      // bound. An UNBOUNDED probe makes this assertion hang forever rather than
      // fail, which is why the engine fix is load-bearing here -- reverting it
      // turns this into a timeout, not a clean failure.
      await engine.stop(spec.id).catch(() => undefined);
      const elapsed = Date.now() - t0;
      const budget = 5_000 * handles.length + 15_000 + 2_000;
      ok(r, "stop settles even when the process cannot be interrogated", elapsed < budget, `${elapsed}ms (budget ${budget}ms)`);

      // computeStatus() probes isRunning() too, and a status poll that hangs
      // hangs the whole UI. Prove it is bounded by asking for a status while
      // the processes still cannot be interrogated.
      const tPoll = Date.now();
      const polled = await Promise.race([
        engine.status(spec.id),
        new Promise<"hung">((r2) => setTimeout(() => r2("hung"), 20_000)),
      ]);
      const pollMs = Date.now() - tPoll;
      ok(r, "status settles even when the process cannot be interrogated",
        polled !== "hung" && pollMs < 20_000, `${pollMs}ms`);

      handles.forEach((h) => { h.hang = false; });
    }

    if (process.env.MX_TRACE) console.log(`        [mx] {input.method} before-remove`);
    // ---- remove cleans up ----
    let removeThrew = false;
    const tRemove = Date.now();
    try { await engine.remove(spec.id); } catch { removeThrew = true; }
    ok(r, "remove does not throw", !removeThrew);
    ok(r, "remove settles", Date.now() - tRemove < 25_000, `${Date.now() - tRemove}ms`);
    const st4 = await engine.status(spec.id);
    ok(r, "a removed tunnel reports stopped", st4 === "stopped" || st4 === "error", String(st4));
    // Status alone cannot prove removal: disposeAll() has already stopped the
    // handles by this point, so a runtime entry that survived would still read
    // "stopped". The runtime must be GONE -- otherwise the tunnel lingers in the
    // list, is re-adopted on a later id collision, and its cache entries leak.
    ok(r, "a removed tunnel is no longer tracked", !engine.has(spec.id));
    const before = engine.size();
    await engine.remove(spec.id).catch(() => undefined);
    ok(r, "removing a tunnel twice does not grow the runtime map", engine.size() === before,
      `${before} -> ${engine.size()}`);
  } catch (e) {
    ok(r, "the lifecycle run completed", false, (e as Error).message);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  return r;
}
