import { spawn } from "node:child_process";
import { promises as fsp, createWriteStream } from "node:fs";
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
  /**
   * Bounded respawn policy for child-process mode. All fields are optional and
   * clamped; nothing here can produce an unbounded or zero-length delay.
   */
  retry?: RetryPolicy;
}

/**
 * Respawn policy. Every value is bounded at construction so a misconfigured
 * policy can neither spin nor sleep for hours.
 */
export interface RetryPolicy {
  /** first backoff delay in ms (default 2000) */
  baseDelayMs?: number;
  /** ceiling for the exponential backoff in ms (default 30000) */
  maxDelayMs?: number;
  /**
   * give up after this many consecutive failures (default 10). `null` retries
   * forever, which is only appropriate when a supervisor such as systemd is
   * also watching.
   */
  maxAttempts?: number | null;
  /** window after which the failure streak resets in ms (default 60000) */
  resetAfterMs?: number;
}

const RETRY_DEFAULTS = {
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  maxAttempts: 10,
  resetAfterMs: 60_000,
} as const;

/** Clamp a policy into safe bounds. Never throws, never returns 0 or Infinity. */
export type ClampedRetryPolicy = Required<Omit<RetryPolicy, "maxAttempts">> & { maxAttempts: number | null };

export function clampRetryPolicy(policy: RetryPolicy | undefined): ClampedRetryPolicy {
  const raw = policy ?? {};
  const clampDelay = (value: number | undefined, fallback: number, ceiling: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
    return Math.min(Math.max(Math.floor(value), 100), ceiling);
  };
  const attempts = raw.maxAttempts === null
    ? null
    : typeof raw.maxAttempts === "number" && Number.isFinite(raw.maxAttempts)
      ? Math.max(1, Math.min(Math.floor(raw.maxAttempts), 1_000))
      : RETRY_DEFAULTS.maxAttempts;
  return {
    baseDelayMs: clampDelay(raw.baseDelayMs, RETRY_DEFAULTS.baseDelayMs, 60_000),
    maxDelayMs: clampDelay(raw.maxDelayMs, RETRY_DEFAULTS.maxDelayMs, 600_000),
    maxAttempts: attempts,
    resetAfterMs: clampDelay(raw.resetAfterMs, RETRY_DEFAULTS.resetAfterMs, 3_600_000),
  };
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
  /** bounded retry state for diagnostics (child-process mode) */
  retryState?: () => { attempts: number; lastDelayMs: number; nextDelayMs: number | null; exhausted: boolean };
  dispose(): Promise<void>;
}

/** A scheduled callback, opaque so tests can supply a fake clock. */
export type RetryTimer = unknown;

/** Injection seam used by ChildProcessHandle to schedule retries. */
export interface RetryScheduler {
  setTimeout(fn: () => void, ms: number): RetryTimer;
  clearTimeout(timer: RetryTimer): void;
  now(): number;
}

const defaultScheduler: RetryScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
  now: () => Date.now(),
};

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Strip CR/LF so names/descriptions can't inject systemd directives. */
export function sanitizeUnitText(s: string): string {
  return s.replaceAll(/[\r\n]+/g, " ").slice(0, 200);
}

/** Quote an env value for a systemd `Environment=` directive. Strips control
 *  characters (which could otherwise break out of the directive) and escapes
 *  the two characters systemd treats specially inside double quotes. */
function systemdQuote(s: string): string {
  const cleaned = s.replaceAll(/[\r\n\x00]+/g, "");
  return `"${cleaned.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildUnit(spec: ProcessSpec): string {
  const envFile = spec.envFile ? `EnvironmentFile=${spec.envFile}\n` : "";
  const exec = spec.command.map(shellQuote).join(" ");
  const cd = spec.workdir ? `WorkingDirectory=${spec.workdir}\n` : "";
  const desc = sanitizeUnitText(
    spec.description ?? `Xistance tunnel: ${spec.name}`,
  );
  // Inline per-unit environment (e.g. AUTOSSH_* or SSHPASS). Written as
  // Environment= directives so both systemd and remote nodes inherit them.
  const envLines = Object.entries(spec.env ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `Environment=${k}=${systemdQuote(String(v))}`)
    .join("\n");
  const envBlock = envLines ? `${envLines}\n` : "";
  return `[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${exec}
${cd}${envFile}${envBlock}Restart=on-failure
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
    // 0600: the unit can carry secrets (SSHPASS) in Environment= lines,
    // and the default umask would leave them world-readable on the node.
    await this.runner.writeFile(unitPath, buildUnit(this.spec), 0o600);
    for (const sub of ["daemon-reload", "enable", "start"] as const) {
      const r = await this.systemctl(sub);
      if (r.exitCode !== 0) {
        throw new Error("systemctl " + sub + " " + this.unit() + " failed: " + (r.stderr.trim() || ("exit " + r.exitCode)));
      }
    }
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
    // Full teardown so deleted tunnels stay deleted across reboots: stop +
    // disable the unit, remove its unit file, and reload the daemon.
    // (stop() alone leaves an enabled unit file behind, which systemd — and
    // our own rehydrate — would happily start again on next boot.)
    await this.stop();
    const unitPath = path.join(this.spec.dataDir, "systemd", this.unit());
    await this.runner.run(["rm", "-f", unitPath]);
    await this.runner.run(["systemctl", "daemon-reload"]);
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
  private retryDelay = 0;
  private respawnTimer: RetryTimer | null = null;
  /** consecutive failed starts; reset after a successful run */
  private retryAttempts = 0;
  private lastRetryDelay = 0;
  /** set once the attempt ceiling is reached; cleared by an explicit start() */
  private exhausted = false;
  private readonly policy: ClampedRetryPolicy;
  /**
   * Serialises start(). Two concurrent starts both used to pass the
   * `if (this.child) return` guard while the child was momentarily null (just
   * after an exit), and both went on to spawn — leaving a process nothing
   * tracked and nothing could kill.
   */
  private startInFlight: Promise<void> | null = null;
  onLine: ((line: string) => void) | null = null;

  /**
   * Injection seam for the retry scheduler.
   *
   * Without it, proving "no tight loop" and "delay never exceeds the ceiling"
   * means either waiting 30 real seconds per case or reading the code and
   * trusting it. A deterministic scheduler makes both observable.
   */
  constructor(
    private readonly spec: ProcessSpec,
    private readonly scheduler: RetryScheduler = defaultScheduler,
  ) {
    // Clamped once, here: a field initialiser would run before `spec` is
    // assigned and throw on every construction.
    this.policy = clampRetryPolicy(spec.retry);
  }

  /** Observable retry state for diagnostics; never contains secrets. */
  retryState(): { attempts: number; lastDelayMs: number; nextDelayMs: number | null; exhausted: boolean } {
    return {
      attempts: this.retryAttempts,
      lastDelayMs: this.lastRetryDelay,
      nextDelayMs: this.exhausted ? null : this.retryDelay,
      exhausted: this.exhausted,
    };
  }

  recentLines(): string[] {
    return this.tail;
  }

  async start(): Promise<void> {
    await this.startSerialized(false);
  }

  /**
   * The single entry point for spawning, shared by explicit starts and respawns.
   *
   * Serialised: a second caller waits for the in-flight start instead of
   * racing it. Both used to observe `child === null` right after an exit and
   * both spawned, orphaning a process nothing tracked.
   */
  private async startSerialized(fromRespawn: boolean): Promise<void> {
    if (this.startInFlight) {
      await this.startInFlight;
      // A respawn is not a fresh intent: joining it is correct, and returning
      // here is what we want. An explicit start(), however, is a deliberate
      // "start now, treat this as a new attempt" and MUST fall through so the
      // backoff streak resets -- otherwise an operator pressing start after a
      // crash loop joined the in-flight respawn and the streak never cleared.
      if (fromRespawn) return;
    }
    // An explicit start() is a deliberate "start now, treat this as a new
    // attempt", and it MUST clear the backoff even when a child is already
    // running.
    //
    // The streak lives in startOnce, which this guard used to skip entirely
    // whenever `this.child` was non-null. A crash-looping command has a child
    // almost always, so an operator pressing start during a crash loop joined
    // the in-flight respawn, startOnce never ran, and the streak never reset --
    // the next failure continued from the ceiling. The comment above claimed
    // this was handled; it was the guard, not the fall-through, that prevented
    // it.
    if (this.child) {
      if (!fromRespawn) this.resetStreak();
      return;
    }
    const run = this.startOnce(fromRespawn);
    this.startInFlight = run;
    try {
      await run;
    } finally {
      this.startInFlight = null;
    }
  }

  /**
   * Clear the backoff streak: this is a fresh intent, so the next failure
   * schedules from the base delay rather than continuing to climb.
   *
   * Named rather than inlined at each call site because there are now two paths
   * that must mean the same thing -- an explicit start with a child already
   * running (which returns early without spawning) and an explicit start that
   * goes on to spawn.
   */
  private resetStreak(): void {
    this.exhausted = false;
    this.retryDelay = 0;
    this.retryAttempts = 0;
  }

  private async startOnce(fromRespawn = false): Promise<void> {
    this.cancelPendingRetry();
    this.manualStop = false;
    // A respawn must NOT clear the backoff: doing so made every retry start
    // from the base delay again, so a crash-looping command was respawned
    // forever at 2s with no escalation and no exhaustion. Only an explicit
    // start() is a fresh intent and resets the streak.
    if (!fromRespawn) this.resetStreak();
    await fsp.mkdir(this.spec.workdir ?? this.spec.dataDir, { recursive: true });
    const logPath = path.join(this.spec.dataDir, "logs", `${this.spec.id}.log`);
    await fsp.mkdir(path.dirname(logPath), { recursive: true });
    this.logStream = createWriteStream(logPath, {
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
      if (this.tail.length > 2000) this.tail = this.tail.slice(-2000);
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
        this.scheduleRetry();
      }
      void code;
    });
    this.child.on("error", () => {
      this.child = null;
    });
  }

  /** Cancel a pending retry. Safe to call when nothing is scheduled. */
  private cancelPendingRetry(): void {
    if (this.respawnTimer !== null) {
      this.scheduler.clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
  }

  /**
   * Schedule the next respawn under the bounded policy.
   *
   * Guarantees:
   *  - at most one pending timer (a second call replaces the first);
   *  - the delay is always within [base, max], never 0 and never Infinity;
   *  - the attempt ceiling is honoured, after which the handle reports itself
   *    exhausted instead of retrying forever;
   *  - a successful run resets the streak, so a tunnel that has been up for
   *    hours and then drops starts again from the base delay.
   */
  private scheduleRetry(): void {
    const policy = this.policy;
    const now = this.scheduler.now();

    // A long-enough gap means the process was healthy, so the streak resets.
    if (this.lastExitAt && now - this.lastExitAt > policy.resetAfterMs) {
      this.retryAttempts = 0;
    }
    this.lastExitAt = now;

    if (policy.maxAttempts !== null && this.retryAttempts >= policy.maxAttempts) {
      this.exhausted = true;
      this.retryAttempts = 0;
      this.retryDelay = 0;
      this.cancelPendingRetry();
      return;
    }

    this.retryAttempts += 1;
    const raw = this.retryDelay === 0
      ? policy.baseDelayMs
      : Math.min(this.retryDelay * 2, policy.maxDelayMs);
    const delay = Math.min(Math.max(raw, policy.baseDelayMs), policy.maxDelayMs);
    this.retryDelay = delay;
    this.lastRetryDelay = delay;

    // Replace rather than stack: two live timers would mean two respawns.
    this.cancelPendingRetry();
    this.respawnTimer = this.scheduler.setTimeout(() => {
      // Clear before starting so a start() inside the callback cannot cancel a
      // timer that has already fired, and so a concurrent stop() sees no
      // pending retry.
      this.respawnTimer = null;
      void this.startSerialized(true);
    }, delay);
  }

  async stop(): Promise<void> {
    this.manualStop = true;
    this.cancelPendingRetry();
    this.retryAttempts = 0;
    this.retryDelay = 0;
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
    this.cancelPendingRetry();
    this.retryAttempts = 0;
    this.retryDelay = 0;
    const c = this.child;
    if (c) {
      const exited = new Promise<void>((resolve) => c.once("exit", () => resolve()));
      c.kill("SIGTERM");
      const timer = setTimeout(() => c.kill("SIGKILL"), 8000);
      await exited;
      clearTimeout(timer);
    }
    if (this.logStream) {
      await new Promise<void>((resolve) => {
        this.logStream!.end(() => resolve());
      });
      this.logStream = null;
    }
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
    const raw = await fsp.readFile(`/proc/${pid}/io`, "utf8");
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
