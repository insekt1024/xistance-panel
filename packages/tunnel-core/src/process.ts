import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Runner } from "./runner.js";

// ---------------------------------------------------------------------------
// Process lifecycle: systemd units on Linux VPSes, plain child processes as a
// fallback (WSL / dev boxes). The engine picks the implementation per target.
// ---------------------------------------------------------------------------

export interface ProcessSpec {
  /** stable id (tunnel id) used for unit names + log files */
  id: string;
  name: string;
  /** absolute path to the executable + args */
  command: string[];
  env?: Record<string, string>;
  workdir?: string;
  /** directory that holds logs and configs for this unit */
  dataDir: string;
  /** systemd unit name, e.g. xt-tunnel-<id> */
  unitName: string;
  description?: string;
  /** inject XTENC_KEY etc. from a global env file (see install.sh) */
  envFile?: string;
  /** auto-respawn on unexpected exit (child-process mode only) */
  autorestart?: boolean;
}

export interface ProcessHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  /** true when the underlying unit/process is actively running */
  isRunning(): Promise<boolean>;
  pid(): Promise<number | null>;
  /** bytes read/written counters from /proc/<pid>/io (best effort) */
  ioCounters(): Promise<{ rchar: number; wchar: number } | null>;
  /** attach a live-line listener (child-process mode) */
  onLine?: ((line: string) => void) | null;
  /** recent buffered lines (child-process mode) */
  recentLines?: () => string[];
  dispose(): Promise<void>;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

function buildUnit(spec: ProcessSpec): string {
  const envFile = spec.envFile ? `EnvironmentFile=${spec.envFile}\n` : "";
  const exec = spec.command.map(shellQuote).join(" ");
  const cd = spec.workdir ? `WorkingDirectory=${spec.workdir}\n` : "";
  const desc = spec.description ?? `Xistance tunnel: ${spec.name}`;
  return `[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
${cd}${envFile}Restart=on-failure
RestartSec=5
User=root
RuntimeDirectoryMode=0750

[Install]
WantedBy=multi-user.target
`;
}

// ---------------------------------------------------------------------------
// systemd-backed handle (production path, also used for remote nodes)
// ---------------------------------------------------------------------------

export class SystemdProcessHandle implements ProcessHandle {
  constructor(
    private readonly spec: ProcessSpec,
    private readonly runner: Runner,
  ) {}

  private unit(): string {
    return `${this.spec.unitName}.service`;
  }

  private async systemctl(sub: string, ...extra: string[]): Promise<{ exitCode: number; stderr: string }> {
    const res = await this.runner.run(["systemctl", sub, ...extra, this.unit()]);
    return { exitCode: res.exitCode, stderr: res.stderr };
  }

  async start(): Promise<void> {
    const cfgDir = path.join(this.spec.dataDir, "systemd");
    const unitPath = path.join(cfgDir, this.unit());
    await this.runner.makeDir(cfgDir);
    await this.runner.writeFile(unitPath, buildUnit(this.spec));
    await this.systemctl("daemon-reload");
    await this.systemctl("enable");
    await this.systemctl("start");
  }

  async stop(): Promise<void> {
    await this.systemctl("stop");
    await this.systemctl("disable");
  }

  async restart(): Promise<void> {
    await this.systemctl("restart");
  }

  async isRunning(): Promise<boolean> {
    const res = await this.runner.run([
      "systemctl",
      "is-active",
      "--quiet",
      this.unit(),
    ]);
    return res.exitCode === 0;
  }

  async pid(): Promise<number | null> {
    const res = await this.runner.run([
      "systemctl",
      "show",
      "-p",
      "MainPID",
      "--value",
      this.unit(),
    ]);
    const pid = Number.parseInt(res.stdout.trim(), 10);
    return pid > 1 ? pid : null;
  }

  async ioCounters(): Promise<{ rchar: number; wchar: number } | null> {
    const pid = await this.pid();
    if (!pid) return null;
    return readProcIo(pid);
  }

  async dispose(): Promise<void> {
    await this.systemctl("stop");
  }
}

// ---------------------------------------------------------------------------
// child-process-backed handle (dev / non-systemd fallback)
// ---------------------------------------------------------------------------

export class ChildProcessHandle implements ProcessHandle {
  private child: import("node:child_process").ChildProcess | null = null;
  private manualStop = false;
  private logStream: import("node:fs").WriteStream | null = null;
  private tail: string[] = [];
  private lastExitAt = 0;
  private respawnDelay = 0;
  private respawnTimer: NodeJS.Timeout | null = null;
  onLine: ((line: string) => void) | null = null;

  constructor(private readonly spec: ProcessSpec) {}

  recentLines(): string[] {
    return this.tail;
  }

  async start(): Promise<void> {
    if (this.child) return;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    this.manualStop = false;
    this.respawnDelay = 0;
    await fs.mkdir(this.spec.workdir ?? this.spec.dataDir, { recursive: true });
    const logPath = path.join(this.spec.dataDir, "logs", `${this.spec.id}.log`);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    this.logStream = (await import("node:fs")).createWriteStream(logPath, {
      flags: "a",
    });

    const [cmd, ...args] = this.spec.command;
    this.child = spawn(cmd, args, {
      env: { ...process.env, ...this.spec.env },
      cwd: this.spec.workdir ?? this.spec.dataDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const sink = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const line = chunk.toString();
      this.tail.push(line);
      if (this.tail.length > 2000) this.tail.shift();
      this.logStream?.write(`[${stream}] ${line}`);
      this.onLine?.(line);
    };
    this.child.stdout?.on("data", sink("stdout"));
    this.child.stderr?.on("data", sink("stderr"));

    this.child.on("exit", (code) => {
      this.child = null;
      this.logStream?.end();
      this.logStream = null;
      // Auto-respawn unless intentionally stopped, with an exponential backoff
      // (2s -> 4s -> 8s ... capped at 30s) so a crash-looping command doesn't
      // hammer the system.
      if (!this.manualStop && this.spec.autorestart !== false) {
        const now = Date.now();
        if (this.lastExitAt && now - this.lastExitAt < 60_000) {
          this.respawnDelay = this.respawnDelay ? Math.min(this.respawnDelay * 2, 30_000) : 2_000;
        } else {
          this.respawnDelay = 2_000;
        }
        this.lastExitAt = now;
        this.respawnTimer = setTimeout(() => void this.start(), this.respawnDelay);
      }
      void code;
    });
    this.child.on("error", () => {
      this.child = null;
    });
  }

  async stop(): Promise<void> {
    this.manualStop = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    const c = this.child;
    if (!c) return;
    const exited = new Promise<void>((resolve) => c.once("exit", () => resolve()));
    c.kill("SIGTERM");
    const timer = setTimeout(() => c.kill("SIGKILL"), 8000);
    await exited;
    clearTimeout(timer);
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async isRunning(): Promise<boolean> {
    return this.child !== null && this.child.exitCode === null;
  }

  async pid(): Promise<number | null> {
    return this.child?.pid ?? null;
  }

  async ioCounters(): Promise<{ rchar: number; wchar: number } | null> {
    const pid = this.child?.pid;
    if (!pid) return null;
    return readProcIo(pid);
  }

  async dispose(): Promise<void> {
    this.manualStop = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    this.child?.kill("SIGTERM");
    this.logStream?.end();
  }
}

// ---------------------------------------------------------------------------
// /proc/<pid>/io reader (Linux). rchar/wchar approximate socket bytes for a
// relay process — good enough for dashboard traffic totals.
// ---------------------------------------------------------------------------

export async function readProcIo(
  pid: number,
): Promise<{ rchar: number; wchar: number } | null> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/io`, "utf8");
    const rchar = Number(/rchar:\s+(\d+)/.exec(raw)?.[1] ?? 0);
    const wchar = Number(/wchar:\s+(\d+)/.exec(raw)?.[1] ?? 0);
    return { rchar, wchar };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Process manager: chooses implementation based on target + systemd presence.
// ---------------------------------------------------------------------------

export interface ProcessManagerOptions {
  runner: Runner;
  /** force node-child fallback even when systemd exists (e.g. dev override) */
  forceNode?: boolean;
  /** global env file path to inject into units (install.sh) */
  envFile?: string;
}

export class ProcessManager {
  constructor(private readonly opts: ProcessManagerOptions) {}

  async create(spec: ProcessSpec): Promise<ProcessHandle> {
    const useSystemd =
      !this.opts.forceNode &&
      (await this.systemdAvailable()) &&
      this.opts.runner.kind === "local";

    if (useSystemd) {
      return new SystemdProcessHandle(
        { ...spec, envFile: this.opts.envFile ?? spec.envFile },
        this.opts.runner,
      );
    }
    if (this.opts.runner.kind === "remote") {
      // Remote nodes always run real systemd (managed VPS).
      return new SystemdProcessHandle(spec, this.opts.runner);
    }
    return new ChildProcessHandle(spec);
  }

  private cachedSystemd: boolean | null = null;
  private async systemdAvailable(): Promise<boolean> {
    if (this.cachedSystemd !== null) return this.cachedSystemd;
    try {
      const res = await this.opts.runner.run(["systemctl", "--version"]);
      this.cachedSystemd = res.exitCode === 0;
    } catch {
      this.cachedSystemd = false;
    }
    return this.cachedSystemd;
  }
}
