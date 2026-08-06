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
  readonly bus: EventBus;

  constructor(private readonly opts: EngineOptions) {
    this.bus = new EventBus();
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

  /** Resolve a system tool (ssh, sshpass, node) on the target. */
  private async systemBin(ctx: NodeCtx, name: string): Promise<string> {
    const res = await ctx.runner.run(["which", name]);
    const found = res.stdout.trim();
    if (res.exitCode !== 0 || !found) {
      throw new Error(
        `Required system tool "${name}" is missing on ${ctx.name}. ` +
          `Install it (Ubuntu/Debian: apt install ${name}) and retry.`,
      );
    }
    return found;
  }

  // ---- deploy -------------------------------------------------------------

  async deploy(spec: TunnelDeploySpec): Promise<void> {
    const plan = await this.buildPlan(spec);
    const procs: RunningProcess[] = [];
    for (const entry of plan) {
      for (const f of entry.files ?? []) {
        await entry.ctx.runner.writeFile(f.path, f.content, f.mode);
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
    for (const p of procs) await p.handle.start();
    this.runtimes.set(spec.id, { processes: procs });
  }

  // ---- lifecycle -----------------------------------------------------------

  async start(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    for (const p of rt.processes) await p.handle.start();
  }

  async stop(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    await Promise.all(rt.processes.map((p) => p.handle.stop()));
  }

  async restart(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    for (const p of rt.processes) await p.handle.restart();
  }

  /** Stop processes and forget the runtime (tunnel delete). */
  async remove(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (rt) {
      await Promise.all(rt.processes.map((p) => p.handle.dispose()));
      this.runtimes.delete(id);
    }
  }

  has(id: string): boolean {
    return this.runtimes.has(id);
  }

  // ---- status / stats ------------------------------------------------------

  async status(id: string): Promise<Status> {
    const rt = this.runtimes.get(id);
    if (!rt) return TunnelStatus.STOPPED;
    const states = await Promise.all(rt.processes.map((p) => p.handle.isRunning()));
    const running = states.filter(Boolean).length;
    if (running === 0) return TunnelStatus.STOPPED;
    if (running < rt.processes.length) return TunnelStatus.DEGRADED;
    return TunnelStatus.RUNNING;
  }

  async snapshot(id: string): Promise<TrafficSnapshot | null> {
    const rt = this.runtimes.get(id);
    if (!rt) return null;
    let bytesIn = 0;
    let bytesOut = 0;
    let started = 0;
    for (const p of rt.processes) {
      const io = await p.handle.ioCounters();
      if (io) {
        bytesIn += io.rchar;
        bytesOut += io.wchar;
      }
      started = Math.max(started, p.startedAt);
    }
    return {
      bytesIn,
      bytesOut,
      speedInBps: 0,
      speedOutBps: 0,
      uptimeMs: started ? Date.now() - started : 0,
      status: await this.status(id),
    };
  }

  /** Recent log lines (best effort; systemd mode reads journalctl). */
  async recentLogs(id: string, maxLines = 200): Promise<string[]> {
    const rt = this.runtimes.get(id);
    if (!rt) return [];
    const out: string[] = [];
    for (const p of rt.processes) {
      if (p.handle.recentLines) out.push(...p.handle.recentLines().slice(-maxLines));
      else out.push(...(await readJournalctl(p.spec.unitName, maxLines, p.ctx)));
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
      if (p.handle.onLine) {
        const prev = p.handle.onLine;
        p.handle.onLine = (line: string) => {
          prev?.(line);
          this.bus.publish(id, { type: "log", stream: "stdout", line });
        };
        cleanups.push(() => {
          p.handle.onLine = null;
        });
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
      const args = buildGostCommand(c, role);
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
