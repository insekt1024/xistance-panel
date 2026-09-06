import path from "node:path";
import {
  TunnelStatus,
  type BackhaulConfig,
  type FrpConfig,
  type GostConfig,
  type PortForwardRule,
  type SshConfig,
  type TrafficSnapshot,
  type TunnelConfig,
  type TunnelMethod,
  type TunnelStatus as Status,
} from "@xistance/types";
import { buildBackhaulConfig } from "./config/backhaul.js";
import { buildFrpPair } from "./config/frp.js";
import { buildGostCommand } from "./config/gost.js";
import { buildSshCommand } from "./config/ssh.js";
import { ProcessManager, type ProcessHandle, type ProcessSpec } from "./process.js";
import { LocalRunner, RemoteRunner, type Runner } from "./runner.js";
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
}

// ---------------------------------------------------------------------------

export class TunnelEngine {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly mgrCache = new Map<string, ProcessManager>();
  private readonly systemBinCache = new Map<string, string>();
  readonly bus: EventBus;

  // Short-lived status memoisation: page polls and the sampler call status()
  // every few seconds; for remote nodes each check spawns an SSH session, so we
  // coalesce reads within a small window. Invalidated on lifecycle changes.
  private readonly statusCache = new Map<string, { at: number; status: Status }>();
  private static readonly STATUS_CACHE_TTL = 1_500;
  // Per-process isRunning cache: avoids re-spawning SSH sessions for every poll.
  // Keyed by process handle unit name; each entry has its own TTL.
  private readonly processRunningCache = new Map<string, { at: number; running: boolean }>();
  private static readonly PROCESS_RUNNING_CACHE_TTL = 3_000;

  constructor(private readonly opts: EngineOptions) {
    this.bus = new EventBus();
    this.loadPersistentIoStats();
  }

  // ---- context / runner resolution ---------------------------------------

  private ctxFor(node: NodeEndpoint | null | undefined): NodeCtx | null {
    if (!node) return null;
    const isRemote = !node.isLocal && !isLoopbackHost(node.host);
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

  private binPath(ctx: NodeCtx, name: string): string {
    return path.join(ctx.binDir, name);
  }

  /** Resolve a system tool (ssh, sshpass, node) on the target. Results cached
   *  per node+tool — `which` costs a full SSH round-trip on remote nodes. */
  private async systemBin(ctx: NodeCtx, name: string): Promise<string> {
    const key = `${ctx.name}:${name}`;
    const hit = this.systemBinCache.get(key);
    if (hit) return hit;
    const res = await ctx.runner.run(["which", name]);
    const found = res.stdout.trim();
    if (res.exitCode !== 0 || !found) {
      throw new Error(
        `Required system tool "${name}" is missing on ${ctx.name}. ` +
          `Install it (Ubuntu/Debian: apt install ${name}) and retry.`,
      );
    }
    this.systemBinCache.set(key, found);
    return found;
  }

  // ---- deploy -------------------------------------------------------------

  async deploy(spec: TunnelDeploySpec): Promise<void> {
    const plan = await this.buildPlan(spec);
    await this.ensureBinaries(spec);
    const procs: RunningProcess[] = [];
    for (const entry of plan) {
      // Parallelize file writes within each entry (independent of each other)
      if (entry.files) {
        await Promise.all(
          entry.files.map((f) => entry.ctx.runner.writeFile(f.path, f.content, f.mode)),
        );
      }
      const mgr = await this.mgrFor(entry.ctx);
      const handle = await mgr.create(entry.spec);
      procs.push({
        ctx: entry.ctx,
        handle,
        spec: entry.spec,
        startedAt: Date.now(),
      });
    }
    // Parallelize process starts
    await Promise.all(procs.map((p) => p.handle.start()));
    this.runtimes.set(spec.id, { processes: procs });
    this.invalidateStatus(spec.id);
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
    if (!rt) return;
    await Promise.all(rt.processes.map((p) => p.handle.stop()));
    this.invalidateStatus(id);
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
      await Promise.all(rt.processes.map((p) => p.handle.dispose()));
      this.runtimes.delete(id);
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
    const states = await Promise.all(rt.processes.map(async (p) => {
      const cacheKey = p.spec.unitName || p.spec.id || String(p.constructor.name);
      const cached = this.processRunningCache.get(cacheKey);
      if (cached && Date.now() - cached.at < TunnelEngine.PROCESS_RUNNING_CACHE_TTL) {
        return cached.running;
      }
      const running = await p.handle.isRunning();
      this.processRunningCache.set(cacheKey, { at: Date.now(), running });
      return running;
    }));
    const running = states.filter(Boolean).length;
    if (running === 0) return TunnelStatus.STOPPED;
    if (running < rt.processes.length) return TunnelStatus.DEGRADED;
    return TunnelStatus.RUNNING;
  }

  async status(id: string): Promise<Status> {
    const now = Date.now();
    const cached = this.statusCache.get(id);
    if (cached && now - cached.at < TunnelEngine.STATUS_CACHE_TTL) {
      return cached.status;
    }
    const status = await this.computeStatus(id);
    this.statusCache.set(id, { at: now, status });
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
      case "PORT_FORWARD":
        for (const node of [spec.clientNode, spec.serverNode]) {
          const ctx = this.ctxFor(node);
          if (ctx?.runner.kind === "remote") add(node, "gost");
        }
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
      const script = bins
        .map((bin) => {
          const abs = this.binPath(ctx, bin);
          return `[ -e '${abs}' ] && echo "OK ${bin}" || echo "MISSING ${bin}"`;
        })
        .join("; ");
      const res = await ctx.runner.run(["bash", "-c", script]);
      for (const line of res.stdout.split("\n")) {
        if (!line.startsWith("MISSING ")) continue;
        const bin = line.slice("MISSING ".length).trim();
        const abs = this.binPath(ctx, bin);
        throw new Error(
          `Required binary "${bin}" is missing on ${ctx.name} (${abs}). ` +
            `Run scripts/install.sh (or: xistance install --bin ${bin}) on the node to install it.`,
        );
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
      case "SSH":
        return this.planSsh(spec, cfg.ssh);
      case "PORT_FORWARD":
        return this.planPortForward(spec, cfg.portForwards);
    }
  }

  private planBackhaul(spec: TunnelDeploySpec, c: BackhaulConfig): PlanEntry[] {
    const plan: PlanEntry[] = [];
    const server = this.ctxFor(spec.serverNode);
    if (server) {
      const cfgPath = path.join(server.cfgDir, "config.toml");
      plan.push({
        ctx: server,
        files: [{ path: cfgPath, content: buildBackhaulConfig(c, "server") }],
        spec: processSpec(spec, "server", [this.binPath(server, "backhaul"), "-c", cfgPath], server),
      });
    }
    const client = this.ctxFor(spec.clientNode);
    if (client) {
      const cfgPath = path.join(client.cfgDir, "config.toml");
      plan.push({
        ctx: client,
        files: [{ path: cfgPath, content: buildBackhaulConfig(c, "client") }],
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
        files: [{ path: cfgPath, content: pair.server }],
        spec: processSpec(spec, "server", [this.binPath(server, "frps"), "-c", cfgPath], server),
      });
    }
    if (client) {
      const cfgPath = path.join(client.cfgDir, "frpc.toml");
      const pair = buildFrpPair(cfg, spec.serverNode?.host ?? "");
      plan.push({
        ctx: client,
        files: [{ path: cfgPath, content: pair.client }],
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

  private async planSsh(spec: TunnelDeploySpec, c: SshConfig): Promise<PlanEntry[]> {
    const target = c.mode === "remote" ? spec.serverNode : spec.clientNode;
    const ctx = this.ctxFor(target);
    if (!ctx) return [];
    const usePass = c.auth === "password";
    const args = buildSshCommand(c, { keyPath: target?.keyPath });
    const sshBin = await this.systemBin(ctx, "ssh");
    const command = usePass
      ? [await this.systemBin(ctx, "sshpass"), "-e", ...args]
      : [sshBin, ...args];
    const specObj = processSpec(spec, "ssh", command, ctx);
    if (usePass && c.password) specObj.env = { SSHPASS: c.password };
    return [{ ctx, files: [], spec: specObj }];
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
              `-L ${rule.protocol}://:${rule.sourcePort}/${rule.destHost}:${rule.destPort}`,
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

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "::1", "localhost", "local", "self", "0.0.0.0"].includes(
    host.trim().toLowerCase(),
  );
}

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
  return id.replace(/[^A-Za-z0-9_\-]/g, "_").slice(0, 32);
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
