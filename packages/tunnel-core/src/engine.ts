import path from "node:path";
import {
  TunnelStatus,
  type BackhaulConfig,
  type DirectConfig,
  type FrpConfig,
  type GostConfig,
  type IcmpConfig,
  type PortForwardRule,
  type ReverseConfig,
  type SshConfig,
  type TrafficSnapshot,
  type TunnelConfig,
  type TunnelMethod,
  type XrayConfig,
  type XuiConfig,
  type TunnelStatus as Status,
} from "@xistance/types";
import { buildBackhaulConfig } from "./config/backhaul.js";
import { buildFrpPair } from "./config/frp.js";
import { buildGostCommand } from "./config/gost.js";
import {
  buildIcmpClientConfig,
  buildIcmpCommand,
  buildIcmpServerConfig,
  icmpConfigFileName,
} from "./config/pingtunnel.js";
import { buildDirectCommand } from "./config/direct.js";
import { reverseToSshConfig } from "./config/reverse.js";
import { classifyXuiSync, syncXui, type XuiSyncResult } from "./xui-sync.js";
import {
  probeReverseReachability,
  type ReverseReach,
} from "./reachability.js";
import { buildXrayConfig } from "./config/xray.js";
import { normalizePanelUrl } from "./config/xui.js";
import { buildAutosshCommand, buildSshCommand } from "./config/ssh.js";
import { ProcessManager, type ProcessHandle, type ProcessSpec } from "./process.js";
import { buildDiagnostic, diagnosticStore, type TunnelDiagnostic } from "./diagnostics.js";
import { BoundedCache, type Clock } from "./bounded.js";
import {
  buildPreflightScript,
  classifyPreflightLine,
  preflightBin,
  preflightError,
} from "./preflight.js";
import { LocalRunner, RemoteRunner, isLoopback, type Runner } from "./runner.js";
import { EventBus } from "./eventbus.js";
import fs from "node:fs";

// ---------------------------------------------------------------------------
// Public models
// ---------------------------------------------------------------------------

export interface NodeEndpoint {
  id: string;
  host: string;
  username?: string;
  /** true when this node IS the panel host */
  isLocal?: boolean;
  sshPort?: number;
  authMethod?: "key" | "password";
  /** path to the SSH private key on the panel host (key auth) */
  keyPath?: string;
  password?: string;
  remoteBinDir?: string;
  remoteConfigDir?: string;
}

export interface TunnelDeploySpec {
  id: string;
  name: string;
  method: TunnelMethod;
  config: TunnelConfig;
  clientNode?: NodeEndpoint | null;
  serverNode?: NodeEndpoint | null;
}

export interface EngineOptions {
  /** local data root (logs/configs/bins) */
  dataDir: string;
  localBinDir?: string;
  remoteBinDir?: string;
  remoteConfigDir?: string;
  /** master env file injected into systemd units (install.sh) */
  envFile?: string;
  forceNodeFallback?: boolean;
  /** how to launch the port-forward worker as a process */
  forwarderRunner?: { prefix: string[]; script: string };
  /**
   * Test seam: override how a process handle is produced.
   *
   * The engine's lifecycle guarantees (idempotent stop, cleanup after a failed
   * deploy, bounded dispose) are only provable against a handle that can be
   * scripted to fail, hang or report a chosen state. Without this the only way
   * to exercise them is a real spawn, which cannot be made to fail on demand.
   */
  createProcessHandle?: (spec: ProcessSpec) => Promise<ProcessHandle> | ProcessHandle;
  /**
   * Test seam: overrides for the XUI panel verification.
   *
   * `planXui` performs a real HTTP check against the operator's 3X-UI panel.
   * Without a seam, exercising the deploy path in a test means live DNS and
   * live HTTP -- and a bounds regression in the retry policy turns the suite
   * into a multi-minute hang rather than a failure. Same pattern as
   * `createProcessHandle` and `clock`.
   */
  xuiSync?: (cfg: XuiConfig) => Promise<XuiSyncResult>;
  /** Test seam: clock for the bounded caches.
   *
   * `status()` memoises for STATUS_CACHE_TTL and the per-process running answer
   * for PROCESS_RUNNING_CACHE_TTL. Without an injectable clock, proving the
   * expiry behaviour means sleeping for seconds of wall time in every run --
   * and, worse, the alternative is to assert only the cached path, which is
   * exactly the part that can report a dead tunnel as running.
   */
  clock?: Clock;
}

interface NodeCtx {
  name: string;
  runner: Runner;
  binDir: string;
  cfgDir: string;
  dataDir: string;
}

interface PlanFile {
  path: string;
  content: string;
  mode?: number;
}

interface PlanEntry {
  ctx: NodeCtx;
  spec: ProcessSpec;
  files?: PlanFile[];
}

interface RunningProcess {
  ctx: NodeCtx;
  handle: ProcessHandle;
  spec: ProcessSpec;
  startedAt: number;
}

interface Runtime {
  processes: RunningProcess[];
  /** tunnel method — lets status() treat metadata-only (XUI) runtimes correctly */
  method: TunnelMethod;
  /**
   * REVERSE only: where to probe the remote side of the `ssh -R`, and what the
   * operator asked for. Present because a live ssh process does not prove the
   * remote port is reachable -- see reachability.ts.
   */
  reverseProbe?: { ctx: NodeCtx; listenPort: number; requestedAddress: string };
  /**
   * XUI only: the last verification result. XUI has no process, so there is
   * nothing whose liveness proves the tunnel exists -- this field IS the proof,
   * and its absence means "not verified", which must never read as running.
   */
  xuiVerification?: XuiSyncResult;
}

// ---------------------------------------------------------------------------

/**
 * Bound an async operation.
 *
 * A tunnel process handle talks to systemd (or a child process) and nothing
 * guarantees it settles: a wedged SSH session or an unresponsive unit would
 * otherwise hang the HTTP request that triggered the stop, and the operator
 * would see a spinning button instead of an error.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class TunnelEngine {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly mgrCache = new Map<string, ProcessManager>();
  // `path: null` records a *negative* lookup (tool absent) so optional
  // tools are not re-probed on every deploy — each probe is an SSH
  // round-trip on a remote node.
  //
  // Bounded (TASK-23): previously this was a plain Map that was only ever
  // added to, so it grew with every distinct `<node>:<tool>` key probed for the
  // process lifetime. The TTL alone did not bound it -- a long-lived panel
  // probing many nodes and tools accumulated entries indefinitely.
  private readonly systemBinCache: BoundedCache<string, string | null>;
  private static readonly SYSTEM_BIN_CACHE_TTL = 10 * 60_000;
  private static readonly SYSTEM_BIN_CACHE_MAX = 500;
  readonly bus: EventBus;

  // Short-lived status memoisation: page polls and the sampler call status()
  // every few seconds; for remote nodes each check spawns an SSH session, so we
  // coalesce reads within a small window. Invalidated on lifecycle changes.
  private readonly statusCache: BoundedCache<string, Status>;
  private static readonly STATUS_CACHE_TTL = 1_500;
  private static readonly STATUS_CACHE_MAX = 1_000;
  // Per-process isRunning cache: avoids re-spawning SSH sessions for every poll.
  // Keyed by process handle unit name (one entry per process, not per tunnel:
  // a tunnel owns several processes, so tunnel id alone would collide).
  // Unit names embed the full tunnel UUID (see sanitizeUnit), so distinct
  // tunnels cannot poison each other's entries.
  private readonly processRunningCache: BoundedCache<string, boolean>;
  /**
   * REVERSE remote-listener observations. Deliberately short-lived: changing
   * `GatewayPorts` on the Foreign host should be reflected without restarting
   * the tunnel, so this must not hold a verdict for long.
   */
  private readonly reverseReachCache: BoundedCache<string, ReverseReach>;
  /**
   * XUI verification results, keyed by tunnel id. Held separately from
   * `runtimes` because a failed verification must still be visible: a deploy
   * that could not reach the panel produces no runtime entry to hang the
   * status on.
   */
  private readonly xuiVerifications = new Map<string, XuiSyncResult>();
  /**
   * MUST be >= STATUS_CACHE_TTL.
   *
   * `status()` memoises its own answer for STATUS_CACHE_TTL, and each of those
   * answers is derived from a processRunningCache entry. If the process cache
   * outlives the status cache, then every time the status memo expires the
   * recomputation re-reads a still-valid, already-stale `true` -- so a process
   * that died keeps reporting `running` on EVERY poll, permanently. Measured
   * with an injected clock: advancing 10s past the status TTL still returned
   * "running", because the 3s process entry was refilled on each recompute.
   *
   * Only NEGATIVE answers are memoised (see computeStatus): a cached `true` is
   * a hint that a process was alive, and processes die. That is what makes the
   * invariant hold regardless of the relative TTLs -- there is no long-lived
   * `true` for a recompute to re-read.
   */
  private static readonly PROCESS_RUNNING_CACHE_TTL = 3_000;
  private static readonly PROCESS_RUNNING_CACHE_MAX = 2_000;
  /** Upper bound on stopping or disposing one tunnel process. */
  private static readonly DISPOSE_TIMEOUT_MS = 15_000;
  /**
   * Upper bound on ONE isRunning() probe.
   *
   * `stop()` asks each process whether it is still up before deciding what to
   * stop. For a remote node that probe is an SSH session, and a hung session
   * answers nothing. The bound below used to apply only to the handle.stop()
   * call inside disposeAll, so `stop()` itself could block forever on an
   * unreachable host -- a real hang on a 1 vCPU VPS, and the panel's stop
   * button would never come back. This bounds the probe itself.
   *
   * On timeout the process is treated as still running, which is the safe
   * direction: a redundant stop is harmless, a skipped one orphans a process.
   */
  private static readonly IS_RUNNING_TIMEOUT_MS = 5_000;

  constructor(private readonly opts: EngineOptions) {
    this.bus = new EventBus();
    this.systemBinCache = new BoundedCache({
      max: TunnelEngine.SYSTEM_BIN_CACHE_MAX,
      ttlMs: TunnelEngine.SYSTEM_BIN_CACHE_TTL,
      clock: this.opts.clock,
    });
    this.statusCache = new BoundedCache({
      max: TunnelEngine.STATUS_CACHE_MAX,
      ttlMs: TunnelEngine.STATUS_CACHE_TTL,
      clock: this.opts.clock,
    });
    this.processRunningCache = new BoundedCache({
      max: TunnelEngine.PROCESS_RUNNING_CACHE_MAX,
      ttlMs: TunnelEngine.PROCESS_RUNNING_CACHE_TTL,
      clock: this.opts.clock,
    });
    this.reverseReachCache = new BoundedCache({
      max: 500,
      ttlMs: 30_000,
      clock: this.opts.clock,
    });
    this.loadPersistentIoStats();
  }

  // ---- context / runner resolution ---------------------------------------

  private ctxFor(node: NodeEndpoint | null | undefined): NodeCtx | null {
    if (!node) return null;
    const isRemote = !node.isLocal && !isLoopback(node.host);
    const runner: Runner = isRemote
      ? new RemoteRunner({
          host: node.host,
          port: node.sshPort ?? 22,
          username: node.username ?? "root",
          authMethod: node.authMethod ?? "key",
          key: node.keyPath,
          password: node.password,
          configDir: node.remoteConfigDir ?? "/etc/xistance",
        })
      : new LocalRunner();

    return {
      name: node.id,
      runner,
      binDir: isRemote
        ? node.remoteBinDir ?? this.opts.remoteBinDir ?? "/usr/local/bin"
        : this.opts.localBinDir ?? path.join(this.opts.dataDir, "bin"),
      cfgDir: isRemote
        ? node.remoteConfigDir ?? path.join(this.opts.remoteConfigDir ?? "/etc/xistance", "tunnels", node.id)
        : path.join(this.opts.dataDir, "tunnels", node.id),
      dataDir: isRemote
        ? node.remoteConfigDir ?? path.join(this.opts.remoteConfigDir ?? "/etc/xistance", "tunnels", node.id)
        : path.join(this.opts.dataDir, "tunnels", node.id),
    };
  }

  private async mgrFor(ctx: NodeCtx): Promise<ProcessManager> {
    const key = `${ctx.name}:${ctx.runner.kind}:${this.opts.forceNodeFallback ? "node" : "sysd"}`;
    let m = this.mgrCache.get(key);
    if (!m) {
      m = new ProcessManager({
        runner: ctx.runner,
        forceNode: this.opts.forceNodeFallback,
        envFile: this.opts.envFile,
      });
      this.mgrCache.set(key, m);
    }
    return m;
  }

  /**
   * Produce the process handle for a planned entry, honouring the test seam.
   * Kept separate from mgrFor so the manager cache stays keyed by node.
   */
  private async createHandle(ctx: NodeCtx, spec: ProcessSpec): Promise<ProcessHandle> {
    if (this.opts.createProcessHandle) return await this.opts.createProcessHandle(spec);
    const mgr = await this.mgrFor(ctx);
    return await mgr.create(spec);
  }

  private binPath(ctx: NodeCtx, name: string): string {
    return path.join(ctx.binDir, name);
  }

  /** Resolve a system tool (ssh, sshpass, node) on the target. Results cached
   *  per node+tool — `which` costs a full SSH round-trip on remote nodes. */
  private async systemBin(ctx: NodeCtx, name: string): Promise<string> {
    const key = `${ctx.name}:${name}`;
    const missing = () =>
      new Error(
        `Required system tool "${name}" is missing on ${ctx.name}. ` +
          `Install it (Ubuntu/Debian: apt install ${name}) and retry.`,
      );
    // `has`, not a truthiness test on the value: a cached NEGATIVE lookup is
    // stored as null, and `if (hit)` would miss it and re-probe the node over
    // SSH on every deploy -- exactly what this cache exists to prevent.
    if (this.systemBinCache.has(key)) {
      const hit = this.systemBinCache.get(key);
      // A cached negative from systemBinOptional (shared cache) must still
      // fail loudly here rather than leaking null into a command array.
      if (hit === null || hit === undefined) throw missing();
      return hit;
    }
    const res = await ctx.runner.run(["which", name]);
    const found = res.stdout.trim();
    if (res.exitCode !== 0 || !found) {
      this.systemBinCache.set(key, null);
      throw missing();
    }
    this.systemBinCache.set(key, found);
    return found;
  }

  /** Like systemBin, but returns null instead of throwing when the tool is
   *  absent. Used for optional tools (autossh) where a graceful fallback
   *  exists. Negative lookups are cached so a missing tool is not re-probed
   *  on every deploy. */
  private async systemBinOptional(ctx: NodeCtx, name: string): Promise<string | null> {
    const key = `${ctx.name}:${name}`;
    // Same reasoning as systemBinRequired: null is a real cached answer here.
    if (this.systemBinCache.has(key)) return this.systemBinCache.get(key) ?? null;
    const res = await ctx.runner.run(["which", name]);
    const found = res.stdout.trim();
    if (res.exitCode !== 0 || !found) {
      this.systemBinCache.set(key, null);
      return null;
    }
    this.systemBinCache.set(key, found);
    return found;
  }

  // ---- deploy -------------------------------------------------------------

  async deploy(spec: TunnelDeploySpec): Promise<void> {
    // Dispose any predecessor runtime for this id first: without this,
    // redeploys (e.g. port-forward rule updates) leak the old processes and
    // orphan their systemd units while the map entry is overwritten.
    const prev = this.runtimes.get(spec.id);
    if (prev) {
      this.xuiVerifications.delete(spec.id);
      await Promise.all(prev.processes.map((p) => p.handle.dispose()));
      this.runtimes.delete(spec.id);
    }
    const plan = await this.buildPlan(spec);
    // Only XUI is metadata-only. Any other method planning zero processes
    // (e.g. a node that resolved to nothing) is a mis-deploy: fail here so
    // the caller marks the tunnel stopped+error instead of reporting a
    // "running" tunnel with nothing behind it.
    if (plan.length === 0 && spec.method !== "XUI") {
      throw new Error(
        `Deploy planned no processes for ${spec.method} tunnel "${spec.name}". Check the tunnel's nodes and config.`,
      );
    }
    await this.ensureBinaries(spec);
    const procs: RunningProcess[] = [];
    for (const entry of plan) {
      // Parallelize file writes within each entry (independent of each other)
      if (entry.files) {
        await Promise.all(
          entry.files.map((f) => entry.ctx.runner.writeFile(f.path, f.content, f.mode)),
        );
      }
      const handle = await this.createHandle(entry.ctx, entry.spec);
      procs.push({
        ctx: entry.ctx,
        handle,
        spec: entry.spec,
        startedAt: Date.now(),
      });
    }
    // Parallelize process starts. If any start fails, the ones that DID start
    // are real processes on a real host and must be torn down: nothing in the
    // map tracks them yet, so without this they run forever with no way to
    // stop them from the panel.
    const started: RunningProcess[] = [];
    try {
      for (const proc of procs) {
        await proc.handle.start();
        started.push(proc);
      }
    } catch (error) {
      await this.disposeAll(started);
      this.runtimes.delete(spec.id);
      this.invalidateStatus(spec.id);
      // Record WHY, sanitised. The message may come from a plan whose argv
      // contained a decrypted secret, so only the classified, redacted form is
      // retained -- never the raw error.
      this.publishDiagnostic(spec.id, {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    // For REVERSE, remember where to check the remote listener. Liveness alone
    // would report `running` even when the remote sshd bound the port to
    // loopback because GatewayPorts is `no`, which is the single most
    // misleading thing this panel could show for a reverse tunnel.
    let reverseProbe: Runtime["reverseProbe"];
    if (spec.method === "REVERSE" && spec.config.method === "REVERSE" && procs.length > 0) {
      const sshCfg = reverseToSshConfig(spec.config.reverse, spec.serverNode?.host ?? "");
      const ctx = this.ctxFor(spec.serverNode ?? spec.clientNode);
      if (ctx && sshCfg.host) {
        reverseProbe = {
          ctx,
          listenPort: sshCfg.remotePort,
          requestedAddress: sshCfg.remoteBindAddr,
        };
      }
    }
    this.runtimes.set(spec.id, {
      processes: procs,
      method: spec.method,
      reverseProbe,
      xuiVerification: this.xuiVerifications.get(spec.id),
    });
    this.invalidateStatus(spec.id);
    // A successful deploy is itself a transition worth recording: it clears
    // any prior error and resets the retry streak, so the UI stops offering a
    // recovery action for a tunnel that is now healthy.
    //
    // EXCEPT for a metadata-only XUI tunnel. Its "deploy" is a panel sync that
    // planXui already recorded, and it can record a failure: publishing an
    // unconditional `running` here overwrote that classified reason, so the UI
    // showed a healthy tunnel whose panel sync had in fact failed. The recorded
    // outcome is the truth for this method, so keep it.
    if (spec.config.method !== "XUI") {
      this.publishDiagnostic(spec.id, { status: "running" });
    }
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    for (const p of rt.processes) await p.handle.start();
    this.invalidateStatus(id);
  }

  async stop(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    // A stop for an unknown tunnel is a no-op, which is what makes stop
    // idempotent: the second call finds nothing tracked and does nothing.
    if (!rt) {
      this.invalidateStatus(id);
      return;
    }
    // Idempotent stop: only processes that evidence says are still running are
    // stopped. Re-issuing `systemctl stop` / a second SIGTERM for an already
    // stopped unit is wasted work, and a stop button the operator can mash
    // should not turn into a burst of remote commands.
    const stillRunning: RunningProcess[] = [];
    for (const proc of rt.processes) {
      try {
        // Bounded: a probe that never answers must not hold stop() open. The
        // timeout is caught below and treated as "probably still running".
        const running = await withTimeout(
          proc.handle.isRunning(),
          TunnelEngine.IS_RUNNING_TIMEOUT_MS,
          `isRunning probe for ${proc.spec.id} exceeded ${TunnelEngine.IS_RUNNING_TIMEOUT_MS}ms`,
        );
        if (running) stillRunning.push(proc);
      } catch {
        // If the evidence is unavailable, assume it is running: skipping a
        // real process would be worse than a redundant stop.
        stillRunning.push(proc);
      }
    }
    await this.disposeAll(stillRunning, "stop");
    // An intentional stop is a clean terminal state, not a failure: it clears
    // the error category so the UI does not keep showing a recovery action.
    this.publishDiagnostic(id, { status: "stopped" });
    this.invalidateStatus(id);
  }

  /**
   * Apply one teardown operation to every process, bounded and never throwing.
   *
   * A handle that hangs must not hang the request, and one that fails must not
   * prevent the others from being cleaned up. Failures are reported, not
   * swallowed, because a unit that could not be stopped is a real problem the
   * operator needs to see.
   */
  private async disposeAll(
    procs: RunningProcess[],
    mode: "stop" | "dispose" = "dispose",
    timeoutMs = TunnelEngine.DISPOSE_TIMEOUT_MS,
  ): Promise<void> {
    const errors: string[] = [];
    await Promise.all(
      procs.map(async (proc) => {
        try {
          await withTimeout(
            mode === "stop" ? proc.handle.stop() : proc.handle.dispose(),
            timeoutMs,
            `tunnel process ${proc.spec.id} did not ${mode} within ${timeoutMs}ms`,
          );
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }),
    );
    if (errors.length > 0) {
      throw new Error(`cleanup failed for ${errors.length} tunnel process(es): ${errors.join("; ")}`);
    }
  }

  async restart(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    for (const p of rt.processes) await p.handle.restart();
    this.invalidateStatus(id);
  }

  /** Stop processes and forget the runtime (tunnel delete). */
  async remove(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (rt) {
      // Capture cache keys BEFORE deleting the runtime: invalidateStatus()
      // looks the runtime up by id to find its processes, so evicting after
      // the delete would leave stale processRunningCache entries behind.
      const cacheKeys = rt.processes.map(
        (p) => p.spec.unitName || p.spec.id || String(p.constructor.name),
      );
      await this.disposeAll(rt.processes);
      this.runtimes.delete(id);
      this.xuiVerifications.delete(id);
      for (const k of cacheKeys) this.processRunningCache.delete(k);
    }
    this.invalidateStatus(id);
  }

  has(id: string): boolean {
    return this.runtimes.has(id);
  }

  /** Number of tunnels currently managed by the engine. */
  size(): number {
    return this.runtimes.size;
  }

  /** Clear status and process-running caches for a tunnel. */
  private invalidateStatus(id: string): void {
    this.statusCache.delete(id);
    // A restart or a re-deploy must re-probe the remote listener: the whole
    // point of the cache is to avoid a shell round-trip per poll, not to pin a
    // stale verdict across a lifecycle transition.
    this.reverseReachCache.delete(id);
    // Invalidate per-process running cache for all processes in this runtime
    const rt = this.runtimes.get(id);
    if (rt) {
      for (const p of rt.processes) {
        this.processRunningCache.delete(p.spec.unitName || p.spec.id || String(p.constructor.name));
      }
    }
    // Flush any pending stats write
    if (this.statsWriteTimer) {
      clearTimeout(this.statsWriteTimer);
      this.statsWriteTimer = null;
      void this.savePersistentIoStats();
    }
  }

  /** bytes read/written per process (cumulative) */
  // NOTE: recentIo was removed; persistentIoStats serves double duty now.

  /** child-process handles that already have the engine log sink wired up */
  private readonly logSinks = new WeakSet<ProcessHandle>();

  /**
   * Bounded per-tunnel diagnostic history (TASK-22).
   *
   * Kept on the engine rather than in a module global so it shares the engine's
   * lifetime and cannot leak across a restart. The cap is a count rather than a
   * time window, because a quiet tunnel and a crash-looping one warrant
   * different retention.
   */
  private readonly diagnostics = diagnosticStore(20);
  // Persistent I/O stats surviving engine restarts; loaded from .data/engine-stats.json
  private readonly persistentIoStats: Map<string, { at: number; bytesIn: number; bytesOut: number }> =
    new Map();
  // Debounce timer for async stats persistence
  private statsWriteTimer: NodeJS.Timeout | null = null;

  private loadPersistentIoStats(): void {
    try {
      const data = fs.readFileSync(path.join(this.opts.dataDir, "engine-stats.json"), "utf8");
      const parsed: Record<string, { at: number; bytesIn: number; bytesOut: number }> = JSON.parse(
        data,
      ) as Record<string, { at: number; bytesIn: number; bytesOut: number }>;
      this.persistentIoStats.clear();
      // Merge persisted stats, keeping the most recent timestamp per tunnel
      Object.entries(parsed).forEach(([k, { at, bytesIn, bytesOut }]) => {
        const existing = this.persistentIoStats.get(k);
        if (!existing || at > existing.at) {
          this.persistentIoStats.set(k, { at, bytesIn, bytesOut });
        }
      });
    } catch {
      // No persisted stats yet - fine, start fresh
    }
  }

  private async savePersistentIoStats(): Promise<void> {
    try {
      const data: Record<string, { at: number; bytesIn: number; bytesOut: number }> = {};
      this.persistentIoStats.forEach((v, k) => (data[k] = v));
      await fs.promises.writeFile(
        path.join(this.opts.dataDir, "engine-stats.json"),
        JSON.stringify(data),
        "utf8",
      );
    } catch {
      // Ignore write failures; speed calc degrades gracefully.
    }
  }

  /** Flush pending debounced stats to disk immediately (call on shutdown). */
  flushStats(): void {
    if (this.statsWriteTimer) {
      clearTimeout(this.statsWriteTimer);
      this.statsWriteTimer = null;
      // Synchronous write is intentional here: the process may be exiting.
      try {
        const data: Record<string, { at: number; bytesIn: number; bytesOut: number }> = {};
        this.persistentIoStats.forEach((v, k) => (data[k] = v));
        fs.writeFileSync(
          path.join(this.opts.dataDir, "engine-stats.json"),
          JSON.stringify(data),
          "utf8",
        );
      } catch {
        /* best effort */
      }
    }
  }

  private async ioSums(id: string): Promise<{ bytesIn: number; bytesOut: number; started: number }> {
    const rt = this.runtimes.get(id);
    if (!rt) return { bytesIn: 0, bytesOut: 0, started: 0 };
    const ios = await Promise.all(rt.processes.map((p) => p.handle.ioCounters()));
    let bytesIn = 0;
    let bytesOut = 0;
    let started = 0;
    for (let i = 0; i < rt.processes.length; i++) {
      const io = ios[i];
      if (io) {
        bytesIn += io.rchar;
        bytesOut += io.wchar;
      }
      started = Math.max(started, rt.processes[i].startedAt);
    }
    return { bytesIn, bytesOut, started };
  }

  /** Drop the memoised status and process-running caches for a tunnel. */
  private async computeStatus(id: string): Promise<Status> {
    const rt = this.runtimes.get(id);
    if (!rt) return TunnelStatus.STOPPED;
    // XUI tunnels are metadata-only (no local process): a tracked runtime
    // means the last 3X-UI sync succeeded, so report running. Any other
    // method with zero processes is a mis-deploy, not a running tunnel.
    if (rt.processes.length === 0) {
      if (rt.method !== "XUI") return TunnelStatus.STOPPED;
      // XUI runs no process, so `running` has to come from a real panel check.
      // With no recorded verification there is nothing to stand behind that
      // claim -- report error rather than inventing health.
      if (!rt.xuiVerification) return TunnelStatus.ERROR;
      return classifyXuiSync(rt.xuiVerification);
    }
    // A negative answer is authoritative and must be cached. A positive one is
    // only a hint: a process can die between polls, so `true` is re-probed on
    // every computeStatus rather than memoised. Without this, a process that
    // died kept reporting `running` indefinitely -- the cached `true` was
    // refreshed on each recompute, so it never expired. (Measured with an
    // injected clock: 10s past the TTL still read "running".)
    const states = await Promise.all(rt.processes.map(async (p) => {
      const cacheKey = p.spec.unitName || p.spec.id || String(p.constructor.name);
      // `false` is a real cached answer, so test presence rather than value.
      const cached = this.processRunningCache.get(cacheKey);
      if (cached === false) return false;
      // Bounded for the same reason as in stop(): this probe is an SSH session
      // for a remote node, and an unanswered one would hang every status poll
      // and every UI refresh. A timeout is treated as "not running", because
      // the alternative is a panel that never loads.
      let running = false;
      try {
        running = await withTimeout(
          p.handle.isRunning(),
          TunnelEngine.IS_RUNNING_TIMEOUT_MS,
          `isRunning probe for ${p.spec.id} exceeded ${TunnelEngine.IS_RUNNING_TIMEOUT_MS}ms`,
        );
      } catch {
        running = false;
      }
      if (!running) this.processRunningCache.set(cacheKey, false);
      else this.processRunningCache.delete(cacheKey);
      return running;
    }));
    const running = states.filter(Boolean).length;
    if (running === 0) return TunnelStatus.STOPPED;
    if (running < rt.processes.length) return TunnelStatus.DEGRADED;

    // REVERSE: the process is alive and fully up, but that is not the same as
    // the port being reachable. An `ssh -R` whose remote sshd has
    // `GatewayPorts no` binds loopback and fails silently, so the honest status
    // is `degraded` with an explanation rather than `running`.
    if (rt.reverseProbe) {
      const reach = await this.probeReverse(id, rt.reverseProbe);
      if (!reach.reachable) {
        this.publishDiagnostic(id, { status: "degraded", error: reach.reason });
        return TunnelStatus.DEGRADED;
      }
    }
    return TunnelStatus.RUNNING;
  }

  /**
   * Ask the Foreign node what address its listener actually ended up on.
   *
   * Best-effort by design: a probe failure (no `ss`, an unreachable node, a
   * permission error) must NOT downgrade a working tunnel, because that would
   * train operators to ignore `degraded`. Only a confident observation that the
   * port is loopback-bound or not listening downgrades the status.
   */
  private async probeReverse(
    id: string,
    probe: { ctx: NodeCtx; listenPort: number; requestedAddress: string },
  ): Promise<ReverseReach> {
    const cached = this.reverseReachCache.get(id);
    if (cached) return cached;
    let bound: string | null = null;
    let listening = false;
    try {
      // One shell round-trip. `ss -ltnH` prints "LISTEN 0 128 0.0.0.0:8080 0.0.0.0:*".
      const res = await probe.ctx.runner.run([
        "bash",
        "-c",
        `ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E '[:.]${probe.listenPort}$' | head -n1`,
      ]);
      const line = (res.stdout ?? "").trim().split("\n")[0]?.trim() ?? "";
      if (line) {
        listening = true;
        // Strip the :port suffix; keep [brackets] for IPv6.
        const m = line.match(/^(.*):\d+$/);
        bound = m ? m[1] : line;
      }
    } catch {
      // Indeterminate. Report the requested address so the caller sees a
      // reachable answer rather than inventing a fault.
      return probeReverseReachability({
        boundAddress: probe.requestedAddress,
        requestedAddress: probe.requestedAddress,
        listening: true,
      });
    }
    const reach = probeReverseReachability({
      boundAddress: bound,
      requestedAddress: probe.requestedAddress,
      listening,
    });
    // Only cache a definitive answer, and only for a short window: a
    // GatewayPorts change should be picked up without a restart.
    if (listening) this.reverseReachCache.set(id, reach);
    return reach;
  }

  async status(id: string): Promise<Status> {
    const now = Date.now();
    const cached = this.statusCache.get(id);
    if (cached) return cached;
    const status = await this.computeStatus(id);
    this.statusCache.set(id, status);
    return status;
  }

  async snapshot(id: string): Promise<TrafficSnapshot | null> {
    const rt = this.runtimes.get(id);
    if (!rt) return null;
    const now = Date.now();
    const { bytesIn, bytesOut, started } = await this.ioSums(id);

    // Speed is a delta against the previous snapshot for this tunnel.
    const prev = this.persistentIoStats.get(id);
    let speedInBps = 0;
    let speedOutBps = 0;
    if (prev && prev.at < now) {
      const dt = (now - prev.at) / 1000;
      if (dt > 0) {
        speedInBps = Math.max(0, Math.round((bytesIn - prev.bytesIn) / dt));
        speedOutBps = Math.max(0, Math.round((bytesOut - prev.bytesOut) / dt));
      }
    }
    // Update persistent store
    this.persistentIoStats.set(id, { at: now, bytesIn, bytesOut });
    // Debounced async write: coalesce multiple snapshots into a single write every 5s
    if (this.statsWriteTimer) clearTimeout(this.statsWriteTimer);
    this.statsWriteTimer = setTimeout(() => {
      this.statsWriteTimer = null;
      void this.savePersistentIoStats();
    }, 5_000);

    return {
      bytesIn,
      bytesOut,
      speedInBps,
      speedOutBps,
      uptimeMs: started ? now - started : 0,
      status: await this.status(id),
    };
  }

  /** Recent log lines (best effort; systemd mode reads journalctl). */
  async recentLogs(id: string, maxLines = 200): Promise<string[]> {
    const rt = this.runtimes.get(id);
    if (!rt) return [];
    const out: string[] = [];
    // Parallelize log fetching across processes
    const results = await Promise.all(
      rt.processes.map(async (p) => {
        if (!p.handle.recentLines) {
          return readJournalctl(p.spec.unitName, maxLines, p.ctx);
        }
        const mem = p.handle.recentLines().slice(-maxLines);
        const fileLines = await readLogTail(
          path.join(p.ctx.dataDir, "logs", `${p.spec.id}.log`),
          maxLines,
        );
        // Tail history first, then live in-memory lines. Drop exact duplicates at
        // the seam (the file's end overlaps the memory buffer after a restart).
        const all = [...fileLines, ...mem].slice(-maxLines);
        const deduped: string[] = [];
        for (const line of all) {
          if (deduped[deduped.length - 1] !== line) deduped.push(line);
        }
        return deduped;
      }),
    );
    for (const lines of results) {
      out.push(...lines);
    }
    return out;
  }

  /**
   * Record a lifecycle diagnostic for a tunnel (TASK-22).
   *
   * Only the sanitised payload is stored. The caller may pass the raw error --
   * buildDiagnostic classifies and redacts it -- which is what keeps a command
   * line containing a decrypted password out of the history, the API response
   * and the SSE stream.
   */
  private publishDiagnostic(
    id: string,
    input: { status: string; error?: string | null; retryCount?: number; exhausted?: boolean },
  ): TunnelDiagnostic {
    const d = buildDiagnostic(input);
    this.diagnostics.record(id, d);
    return d;
  }

  /** The newest diagnostic for a tunnel, or null if it has never failed. */
  getDiagnostic(id: string): TunnelDiagnostic | null {
    return this.diagnostics.latest(id);
  }

  /** Bounded diagnostic history for a tunnel, oldest first. */
  listDiagnostics(id: string): TunnelDiagnostic[] {
    return this.diagnostics.list(id);
  }

  /**
   * One-pass aggregate of every tracked tunnel's newest diagnostic.
   *
   * Bounded by the number of tunnels rather than by the history length, and
   * carries no summary text, so it is safe to serve from a cached metrics
   * response. A caller that would otherwise loop `getDiagnostic` per tunnel
   * must use this instead: that loop is a per-request scan, which is exactly
   * the unbounded collection this feature exists to avoid.
   */
  aggregateDiagnostics(): {
    byState: Record<string, number>;
    byErrorCategory: Record<string, number>;
    retrying: number;
    exhausted: number;
    tracked: number;
  } {
    return this.diagnostics.aggregate();
  }

  /** Subscribe to live log lines for a tunnel. Returns an unsubscribe fn. */
  async streamLogs(id: string, cb: (line: string) => void): Promise<() => void> {
    const rt = this.runtimes.get(id);
    if (!rt) return () => undefined;
    const busSub = this.bus.subscribe(id, (ev) => {
      if (ev.type === "log") cb(ev.line);
    });
    const cleanups: Array<() => void> = [];
    for (const p of rt.processes) {
      if (typeof p.handle.recentLines === "function") {
        // Child-process mode: install a single engine-owned sink that feeds the
        // event bus (idempotent, so the first subscriber wires it up once and
        // later subscribers just add a bus subscription). Previous code only
        // wrapped when a listener already existed, so the first subscriber fell
        // through to the journalctl branch and never received live lines.
        if (!this.logSinks.has(p.handle)) {
          const prev = p.handle.onLine;
          p.handle.onLine = (line: string) => {
            prev?.(line);
            this.bus.publish(id, { type: "log", stream: "stdout", line });
          };
          this.logSinks.add(p.handle);
        }
      } else {
        // systemd-managed process: tail via journalctl
        const unit = p.spec.unitName;
        const c = p.ctx.runner.stream(
          ["journalctl", "-u", unit, "-f", "-o", "cat", "--no-pager", "-n", "50"],
          (chunk) => this.bus.publish(id, { type: "log", stream: "stdout", line: chunk }),
          (chunk) => this.bus.publish(id, { type: "log", stream: "stderr", line: chunk }),
          () => {},
        );
        cleanups.push(() => c.kill());
      }
    }
    return () => {
      busSub();
      for (const c of cleanups) c();
    };
  }

  // ---- plan builders -------------------------------------------------------

  /** Verify required tunnel binaries exist on each participating node. */
  private async ensureBinaries(spec: TunnelDeploySpec): Promise<void> {
    const cfg = spec.config;
    const needs: Array<{ ctx: NodeCtx; bin: string }> = [];
    const add = (node: NodeEndpoint | null | undefined, bin: string) => {
      const ctx = node ? this.ctxFor(node) : null;
      if (ctx) needs.push({ ctx, bin });
    };
    switch (cfg.method) {
      case "BACKHAUL":
        add(spec.serverNode, "backhaul");
        add(spec.clientNode, "backhaul");
        break;
      case "FRP":
        add(spec.serverNode, "frps");
        add(spec.clientNode, "frpc");
        break;
      case "GOST":
        for (const node of [spec.clientNode, spec.serverNode]) {
          const role = node === spec.clientNode ? "IRAN" : "FOREIGN";
          if (buildGostCommand(cfg.gost, role)) add(node, "gost");
        }
        break;
      case "ICMP":
        // pingtunnel on BOTH nodes: the client encodes into ICMP echo, the
        // server terminates it with a raw socket. There is no one-node variant.
        add(spec.serverNode, "pingtunnel");
        add(spec.clientNode, "pingtunnel");
        break;
      case "PORT_FORWARD":
        for (const node of [spec.clientNode, spec.serverNode]) {
          const ctx = this.ctxFor(node);
          if (ctx?.runner.kind === "remote") add(node, "gost");
        }
        break;
      case "DIRECT":
        // DIRECT runs on one node (prefer server/Foreign) and reuses the
        // already-installed gost binary — no new dependency on low-RAM hosts.
        add(spec.serverNode ?? spec.clientNode, "gost");
        break;
      case "REVERSE":
        // SSH -R via the system ssh client (autossh when present), resolved
        // at plan time like SSH tunnels — no preflight binary needed here.
        break;
      case "XRAY":
        add(spec.clientNode ?? spec.serverNode, "xray");
        break;
      case "XUI":
        // Metadata-only: syncs over HTTPS with X-UI/3X-UI, no binary needed.
        break;
      default:
        break;
    }
    // Batch existence checks: one shell round-trip per node instead of one
    // SSH session per binary.
    const byCtx = new Map<NodeCtx, string[]>();
    for (const { ctx, bin } of needs) {
      const list = byCtx.get(ctx) ?? [];
      list.push(bin);
      byCtx.set(ctx, list);
    }
    for (const [ctx, bins] of byCtx) {
      const script = buildPreflightScript(
        bins.map((bin) => ({ bin, abs: this.binPath(ctx, bin) })),
      );
      const res = await ctx.runner.run(["bash", "-c", script]);
      for (const line of res.stdout.split("\n")) {
        const outcome = classifyPreflightLine(line);
        if (outcome === null || outcome === "ok") continue;
        const bin = preflightBin(line) ?? "?";
        throw preflightError(outcome, bin, this.binPath(ctx, bin), ctx.name);
      }
    }
  }

  private async buildPlan(spec: TunnelDeploySpec): Promise<PlanEntry[]> {
    const cfg = spec.config;
    switch (cfg.method) {
      case "BACKHAUL":
        return this.planBackhaul(spec, cfg.backhaul);
      case "FRP":
        return this.planFrp(spec, cfg.frp);
      case "GOST":
        return this.planGost(spec, cfg.gost);
      case "ICMP":
        return this.planIcmp(spec, cfg.icmp);
      case "SSH":
        return this.planSsh(spec, cfg.ssh);
      case "PORT_FORWARD":
        return this.planPortForward(spec, cfg.portForwards);
      case "DIRECT":
        return this.planDirect(spec, cfg.direct);
      case "REVERSE":
        return this.planReverse(spec, cfg.reverse);
      case "XRAY":
        return this.planXray(spec, cfg.xray);
      case "XUI":
        return this.planXui(spec, cfg.xui);
      default: {
        // Compile-time exhaustiveness: adding a TunnelMethod without a
        // planner breaks the build here instead of returning undefined.
        const exhaustive: never = cfg;
        throw new Error(
          `Unsupported tunnel method: ${JSON.stringify((exhaustive as { method?: unknown }).method)}`,
        );
      }
    }
  }

  private planBackhaul(spec: TunnelDeploySpec, c: BackhaulConfig): PlanEntry[] {
    const plan: PlanEntry[] = [];
    const server = this.ctxFor(spec.serverNode);
    if (server) {
      const cfgPath = path.join(server.cfgDir, "config.toml");
      plan.push({
        ctx: server,
        // 0600: the config embeds the shared `token`. The default 0644 made it
        // world-readable, so any local user on a shared VPS could read the token
        // and join the tunnel.
        files: [{ path: cfgPath, content: buildBackhaulConfig(c, "server"), mode: 0o600 }],
        spec: processSpec(spec, "server", [this.binPath(server, "backhaul"), "-c", cfgPath], server),
      });
    }
    const client = this.ctxFor(spec.clientNode);
    if (client) {
      const cfgPath = path.join(client.cfgDir, "config.toml");
      plan.push({
        ctx: client,
        files: [{ path: cfgPath, content: buildBackhaulConfig(c, "client"), mode: 0o600 }],
        spec: processSpec(spec, "client", [this.binPath(client, "backhaul"), "-c", cfgPath], client),
      });
    }
    return plan;
  }

  private planFrp(spec: TunnelDeploySpec, cfg: FrpConfig): PlanEntry[] {
    const plan: PlanEntry[] = [];
    const server = this.ctxFor(spec.serverNode);
    const client = this.ctxFor(spec.clientNode);
    if (server) {
      const cfgPath = path.join(server.cfgDir, "frps.toml");
      const pair = buildFrpPair(cfg, spec.serverNode?.host ?? "");
      plan.push({
        ctx: server,
        // 0600: frps.toml embeds the auth token.
        files: [{ path: cfgPath, content: pair.server, mode: 0o600 }],
        spec: processSpec(spec, "server", [this.binPath(server, "frps"), "-c", cfgPath], server),
      });
    }
    if (client) {
      const cfgPath = path.join(client.cfgDir, "frpc.toml");
      const pair = buildFrpPair(cfg, spec.serverNode?.host ?? "");
      plan.push({
        ctx: client,
        // 0600: frpc.toml embeds the auth token.
        files: [{ path: cfgPath, content: pair.client, mode: 0o600 }],
        spec: processSpec(spec, "client", [this.binPath(client, "frpc"), "-c", cfgPath], client),
      });
    }
    return plan;
  }

  private planGost(spec: TunnelDeploySpec, c: GostConfig): PlanEntry[] {
    const plan: PlanEntry[] = [];
    const targets: Array<[NodeEndpoint | null | undefined, "IRAN" | "FOREIGN"]> = [
      [spec.clientNode, "IRAN"],
      [spec.serverNode, "FOREIGN"],
    ];
    for (const [node, role] of targets) {
      const ctx = this.ctxFor(node);
      if (!ctx) continue;
      const peer =
        role === "IRAN" ? spec.serverNode?.host : spec.clientNode?.host;
      const args = buildGostCommand(c, role, {
        peerHost: peer ?? c.forwardHost,
        peerPort: c.listenPort,
      });
      if (!args) continue;
      const [, ...rest] = args;
      plan.push({
        ctx,
        files: [],
        spec: processSpec(spec, role.toLowerCase(), [this.binPath(ctx, "gost"), ...rest], ctx),
      });
    }
    return plan;
  }

  private planIcmp(spec: TunnelDeploySpec, c: IcmpConfig): PlanEntry[] {
    const plan: PlanEntry[] = [];
    const server = this.ctxFor(spec.serverNode);
    const client = this.ctxFor(spec.clientNode);

    if (server) {
      const cfgPath = path.join(
        server.cfgDir,
        icmpConfigFileName(spec.id, "server"),
      );
      plan.push({
        ctx: server,
        // 0600: the file embeds the shared `key` (and the encryption passphrase
        // when set). 0644 would leave both readable by any local user.
        files: [{ path: cfgPath, content: buildIcmpServerConfig(c), mode: 0o600 }],
        spec: processSpec(
          spec,
          "server",
          [this.binPath(server, "pingtunnel"), ...buildIcmpCommand(cfgPath).slice(1)],
          server,
        ),
      });
    }

    if (client) {
      const cfgPath = path.join(
        client.cfgDir,
        icmpConfigFileName(spec.id, "client"),
      );
      // The client needs the SERVER's host, which lives in the node inventory
      // rather than the tunnel config. Without it there is no `-s` to dial, so a
      // missing server node is a hard error rather than a config with no peer.
      const serverHost = spec.serverNode?.host;
      if (!serverHost) {
        throw new Error(
          "ICMP tunnels need a Foreign (server) node: the client must be told which host to reach",
        );
      }
      plan.push({
        ctx: client,
        files: [
          { path: cfgPath, content: buildIcmpClientConfig(c, serverHost), mode: 0o600 },
        ],
        spec: processSpec(
          spec,
          "client",
          [this.binPath(client, "pingtunnel"), ...buildIcmpCommand(cfgPath).slice(1)],
          client,
        ),
      });
    }
    return plan;
  }

  private planDirect(spec: TunnelDeploySpec, c: DirectConfig): PlanEntry[] {
    // Prefer the Foreign node (closest to the target service); fall back to Iran.
    const node = spec.serverNode ?? spec.clientNode;
    const ctx = this.ctxFor(node);
    if (!ctx) return [];
    const [, ...rest] = buildDirectCommand(c);
    return [
      {
        ctx,
        files: [],
        spec: processSpec(spec, "direct", [this.binPath(ctx, "gost"), ...rest], ctx),
      },
    ];
  }

  private async planReverse(spec: TunnelDeploySpec, c: ReverseConfig): Promise<PlanEntry[]> {
    // One process on the Iran node: ssh -R exposes listenPort on the Foreign
    // side, backed by forwardHost:forwardPort locally. Empty host dials the
    // Foreign node's address (the common case) — no extra config needed.
    const sshCfg = reverseToSshConfig(c, spec.serverNode?.host ?? "");
    if (!sshCfg.host) {
      throw new Error(
        "Reverse tunnel needs an SSH target: set host or attach a Foreign node.",
      );
    }
    const entry = await this.sshPlanEntry(spec, spec.clientNode, sshCfg, "reverse");
    return entry ? [entry] : [];
  }

  private planXray(spec: TunnelDeploySpec, c: XrayConfig): PlanEntry[] {
    const node = spec.clientNode ?? spec.serverNode;
    const ctx = this.ctxFor(node);
    if (!ctx) return [];
    const cfgPath = path.join(ctx.cfgDir, "xray.json");
    return [
      {
        ctx,
        files: [{ path: cfgPath, content: buildXrayConfig(c) }],
        spec: processSpec(spec, "xray", [this.binPath(ctx, "xray"), "run", "-c", cfgPath], ctx),
      },
    ];
  }

  private async planXui(spec: TunnelDeploySpec, c: XuiConfig): Promise<PlanEntry[]> {
    // Metadata-only: no process runs, so nothing here consumes memory on a
    // 512MB VPS. But that is exactly why the verification below is load-
    // bearing: with zero processes there is no liveness signal, and an
    // unverified XUI tunnel used to be reported `running` purely because a
    // deploy had been issued.
    const result = await (this.opts.xuiSync ? this.opts.xuiSync(c) : syncXui(c));
    // Recorded even on failure -- an error status with a reason is far more
    // useful than a silent `running`.
    this.xuiVerifications.set(spec.id, result);
    this.invalidateStatus(spec.id);
    if (!result.ok) {
      this.publishDiagnostic(spec.id, {
        status: classifyXuiSync(result) === "degraded" ? "degraded" : "error",
        error: `${result.kind}: ${result.detail}`,
      });
    } else if (classifyXuiSync(result) === "running") {
      // A verified, enabled inbound. This is the only XUI case that is running.
      this.publishDiagnostic(spec.id, { status: "running" });
    } else {
      // TASK-136, second layer. The original code published `running` for BOTH
      // ok cases -- a verified inbound, and a login that confirmed nothing.
      //
      // status() does NOT read this diagnostic for XUI (it computes the status
      // from classifyXuiSync(rt.xuiVerification) in the zero-process branch), so
      // changing this branch cannot move status(). What it DOES drive is the
      // REASON: /api/tunnels does
      //
      //   const actualError = state is error|unknown|degraded
      //     ? engine.getDiagnostic(id)?.summary ?? null : null;
      //
      // and the diagnostics panel renders the same summary. Publishing `running`
      // here therefore left a correctly-`degraded` tunnel with an EMPTY reason --
      // a warning badge with nothing telling the operator what to do.
      //
      // An earlier attempt at this fix was reverted because its mutation did not
      // fail the status()-level gate. The reasoning about status() was right and
      // the conclusion was wrong: the gate measured status(), which this branch
      // does not drive. It is asserted at the layer it does drive.
      this.publishDiagnostic(spec.id, {
        status: "degraded",
        error:
          result.inbound.id === 0
            ? "xui: the panel was reachable, but no inbound was configured to verify -- " +
              "set an inbound id on this tunnel to confirm it is up"
            : `xui: inbound ${result.inbound.id} is present on the panel but not enabled`,
      });
    }

    // Persist a pointer (no credentials) so the UI can show what was last
    // verified after a restart.
    const node = spec.clientNode ?? spec.serverNode;
    const ctx = this.ctxFor(node);
    if (ctx) {
      const cfgPath = path.join(ctx.cfgDir, "xui.json");
      const content = JSON.stringify(
        {
          panelUrl: normalizePanelUrl(c.panelUrl),
          inboundId: c.inboundId ?? null,
          remark: c.remark ?? null,
          // The pointer records the OUTCOME, not just the config, so a restart
          // can tell "never checked" from "checked and unhealthy".
          lastResult: result.ok
            ? { ok: true, inboundId: result.inbound.id, up: result.inbound.up, loginPath: result.loginPath }
            : { ok: false, kind: result.kind, detail: result.detail },
          syncedAt: new Date().toISOString(),
        },
        null,
        2,
      );
      await ctx.runner.writeFile(cfgPath, content);
    }
    return [];
  }

  private async planSsh(spec: TunnelDeploySpec, c: SshConfig): Promise<PlanEntry[]> {
    const target = c.mode === "remote" ? spec.serverNode : spec.clientNode;
    const entry = await this.sshPlanEntry(spec, target, c, "ssh");
    return entry ? [entry] : [];
  }

  /**
   * Shared ssh/autossh plan entry (SSH tunnels + REVERSE one-click tunnels).
   * Resolves the real binaries on the target node, wraps passwords in
   * sshpass, and exports the AUTOSSH_* env the wrapper needs.
   */
  private async sshPlanEntry(
    spec: TunnelDeploySpec,
    target: NodeEndpoint | null | undefined,
    c: SshConfig,
    role: string,
  ): Promise<PlanEntry | null> {
    const ctx = this.ctxFor(target);
    if (!ctx) return null;
    const usePass = c.auth === "password";
    const sshBin = await this.systemBin(ctx, "ssh");

    // autossh respawns the ssh client the moment a link drops, instead of
    // waiting for the process to exit and systemd's RestartSec. It is
    // optional: a node without it falls back to plain ssh.
    const autosshBin = c.useAutossh
      ? await this.systemBinOptional(ctx, "autossh")
      : null;

    // Command builders emit a leading program token ("ssh" / "autossh");
    // planners drop it and substitute the path resolved on the target, the
    // same way planGost does. Passing it through made key-auth tunnels run
    // `ssh ssh -N ... user@host`, where ssh reads the stray token as the
    // destination host and the real destination as a remote command.
    const [, ...args] = autosshBin
      ? buildAutosshCommand(c, { keyPath: target?.keyPath })
      : buildSshCommand(c, { keyPath: target?.keyPath });
    const runBin = autosshBin ?? sshBin;

    const command = usePass
      ? [await this.systemBin(ctx, "sshpass"), "-e", runBin, ...args]
      : [runBin, ...args];

    const specObj = processSpec(spec, role, command, ctx);
    const env: Record<string, string> = {};
    if (usePass && c.password) env.SSHPASS = c.password;
    if (autosshBin) {
      // Monitor from the first second rather than autossh's 30s grace period,
      // so systemd sees a clean start instead of a unit that looks hung.
      env.AUTOSSH_GATETIME = "0";
      env.AUTOSSH_POLL = String(c.autosshPoll ?? 60);
      // Pin the client autossh spawns to the one resolved above, so both
      // agree on which ssh runs even if PATH differs under systemd.
      env.AUTOSSH_PATH = sshBin;
    }
    if (Object.keys(env).length > 0) specObj.env = env;
    return { ctx, files: [], spec: specObj };
  }

  private async planPortForward(
    spec: TunnelDeploySpec,
    rules: PortForwardRule[],
  ): Promise<PlanEntry[]> {
    const plan: PlanEntry[] = [];
    const iran = this.ctxFor(spec.clientNode);
    const foreign = this.ctxFor(spec.serverNode);
    const local = this.opts.forwarderRunner;

    const addLocal = async (ctx: NodeCtx, rs: PortForwardRule[]) => {
      if (!rs.length) return;
      if (!local) throw new Error("forwarderRunner option is required for local port-forward");
      const rulesFile = path.join(ctx.cfgDir, "rules.json");
      plan.push({
        ctx,
        files: [{ path: rulesFile, content: JSON.stringify(rs, null, 2) }],
        spec: processSpec(
          spec,
          "forward",
          [...local.prefix, local.script, "--rules", rulesFile],
          ctx,
        ),
      });
    };
    const addRemoteGost = async (ctx: NodeCtx, rs: PortForwardRule[]) => {
      for (const rule of rs) {
        plan.push({
          ctx,
          files: [],
          spec: processSpec(
            spec,
            `${rule.protocol}-${rule.sourcePort}`,
            [
              this.binPath(ctx, "gost"),
              "-L",
              `${rule.protocol}://:${rule.sourcePort}/${rule.destHost}:${rule.destPort}`,
            ],
            ctx,
          ),
        });
      }
    };

    if (iran) {
      const iranRules = rules.filter((r) => r.direction === "IRAN_TO_FOREIGN");
      if (iran.runner.kind === "local") await addLocal(iran, iranRules);
      else await addRemoteGost(iran, iranRules);
    }
    if (foreign) {
      const foreignRules = rules.filter((r) => r.direction === "FOREIGN_TO_IRAN");
      if (foreign.runner.kind === "local") await addLocal(foreign, foreignRules);
      else await addRemoteGost(foreign, foreignRules);
    }
    return plan;
  }
}

// ---------------------------------------------------------------------------

function processSpec(
  spec: TunnelDeploySpec,
  role: string,
  command: string[],
  ctx: NodeCtx,
): ProcessSpec {
  const unitName = `xt-${sanitizeUnit(spec.id)}-${role}`;
  return {
    id: unitName,
    name: `${spec.name} (${role})`,
    command,
    dataDir: ctx.dataDir,
    unitName,
    env: {},
    autorestart: true,
  };
}

function sanitizeUnit(id: string): string {
  // systemd unit names allow up to 256 chars: no need to truncate to 32,
  // which collided distinct 36-char UUID tunnel ids sharing a prefix.
  return id.replace(/[^A-Za-z0-9_\-]/g, "_").slice(0, 200);
}

async function readJournalctl(unitName: string, lines: number, ctx: NodeCtx): Promise<string[]> {
  try {
    const res = await ctx.runner.run([
      "journalctl",
      "-u",
      unitName,
      "-n",
      String(lines),
      "--no-pager",
      "-o",
      "cat",
    ]);
    if (res.exitCode === 0) return res.stdout.split("\n").filter(Boolean);
  } catch {
    /* journalctl may be unavailable */
  }
  return [];
}

/** Tail the last `lines` lines of a child-process log file (best effort). */
async function readLogTail(filePath: string, lines: number): Promise<string[]> {
  try {
    const stats = await fs.promises.stat(filePath);
    if (stats.size === 0) return [];
    // Read the last 8KB to find the tail efficiently (avoids loading entire large logs)
    const CHUNK = 8192;
    const start = Math.max(0, stats.size - CHUNK);
    const fd = await fs.promises.open(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(stats.size - start);
      await fd.read(buf, 0, buf.length, start);
      const raw = buf.toString("utf8");
      return raw.split("\n").filter(Boolean).slice(-lines);
    } finally {
      await fd.close();
    }
  } catch {
    return [];
  }
}
