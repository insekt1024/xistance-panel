import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Runner: a uniform interface over shell/fs operations, so the engine can drive
// both the local panel host and remote nodes (over SSH) with identical code.
// ---------------------------------------------------------------------------

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Runner {
  readonly kind: "local" | "remote";
  /** Run a command with argv, capture output. */
  run(argv: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<RunResult>;
  /** Stream a command's stdout/stderr to callbacks (used for journalctl tail). */
  stream(
    argv: string[],
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void,
    onExit: (code: number | null) => void,
    opts?: { env?: Record<string, string> },
  ): { kill: () => void };
  writeFile(remotePath: string, content: string, mode?: number): Promise<void>;
  readFile(remotePath: string): Promise<string>;
  makeDir(remotePath: string): Promise<void>;
  exists(remotePath: string): Promise<boolean>;
}

const DEFAULT_TIMEOUT = 30_000;

export class LocalRunner implements Runner {
  readonly kind = "local" as const;

  run(
    argv: string[],
    opts?: { timeoutMs?: number; env?: Record<string, string> },
  ): Promise<RunResult> {
    return new Promise((resolve) => {
      execFile(
        argv[0],
        argv.slice(1),
        {
          timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env, ...opts?.env },
        },
        (err, stdout, stderr) => {
          resolve({
            exitCode: err ? 1 : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          });
        },
      );
    });
  }

  stream(
    argv: string[],
    onStdout: (c: string) => void,
    onStderr: (c: string) => void,
    onExit: (code: number | null) => void,
    opts?: { env?: Record<string, string> },
  ): { kill: () => void } {
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...opts?.env },
    });
    child.stdout.on("data", (d: Buffer) => onStdout(d.toString()));
    child.stderr.on("data", (d: Buffer) => onStderr(d.toString()));
    child.on("exit", (code) => onExit(code));
    return { kill: () => child.kill("SIGTERM") };
  }

  async writeFile(p: string, content: string, mode?: number): Promise<void> {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, mode ? { mode } : undefined);
  }

  async readFile(p: string): Promise<string> {
    return fs.readFile(p, "utf8");
  }

  async makeDir(p: string): Promise<void> {
    await fs.mkdir(p, { recursive: true });
  }

  async exists(p: string): Promise<boolean> {
    return fs
      .access(p)
      .then(() => true)
      .catch(() => false);
  }
}

// ---------------------------------------------------------------------------
// RemoteRunner: executes commands on a remote node via OpenSSH.
// Uses sshpass when the node authenticates with a password.
// ---------------------------------------------------------------------------

export interface SshConnection {
  host: string;
  port: number;
  username: string;
  authMethod: "key" | "password";
  key?: string; // PEM content or path
  password?: string;
  /** Directory on the remote node where tunnel configs are stored. */
  configDir?: string;
}

function sshPassEnv(conn: SshConnection): Record<string, string> | undefined {
  if (conn.authMethod === "password" && conn.password) {
    return { SSHPASS: conn.password };
  }
  return undefined;
}

function sshPassPrefix(conn: SshConnection): string[] {
  if (conn.authMethod === "password" && conn.password) {
    return ["sshpass", "-e"];
  }
  return [];
}

function sshIdentityArgs(conn: SshConnection): string[] {
  const args: string[] = [];
  if (conn.authMethod === "key" && conn.key) {
    if (conn.key.trim().startsWith("-----BEGIN")) {
      // PEM content — must be materialized to a temp file on the panel host.
      throw new Error(
        "Inline SSH key content is not supported by the remote runner; " +
          "provision the key file via the install script instead.",
      );
    }
    args.push("-i", conn.key);
  }
  return args;
}

export class RemoteRunner implements Runner {
  readonly kind = "remote" as const;

  constructor(private readonly conn: SshConnection) {}

  private baseArgs(cmd: string): string[] {
    return [
      ...sshPassPrefix(this.conn),
      "ssh",
      "-p",
      String(this.conn.port),
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "BatchMode=yes",
      ...sshIdentityArgs(this.conn),
      `${this.conn.username}@${this.conn.host}`,
      "bash", "-lc", cmd,
    ];
  }

  run(
    argv: string[],
    opts?: { timeoutMs?: number; env?: Record<string, string> },
  ): Promise<RunResult> {
    const cmd = argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
    const args = this.baseArgs(cmd);
    const passEnv = sshPassEnv(this.conn);
    const env = passEnv ? { ...process.env, ...passEnv, ...opts?.env } : { ...process.env, ...opts?.env };
    return new Promise((resolve) => {
      execFile(
        args[0],
        args.slice(1),
        { timeout: opts?.timeoutMs ?? 60_000, maxBuffer: 10 * 1024 * 1024, env },
        (err, stdout, stderr) => {
          resolve({
            exitCode: err ? 1 : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          });
        },
      );
    });
  }

  stream(
    argv: string[],
    onStdout: (c: string) => void,
    onStderr: (c: string) => void,
    onExit: (code: number | null) => void,
    opts?: { env?: Record<string, string> },
  ): { kill: () => void } {
    const cmd = argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
    const args = this.baseArgs(cmd);
    const passEnv = sshPassEnv(this.conn);
    const env = passEnv ? { ...process.env, ...passEnv, ...opts?.env } : { ...process.env, ...opts?.env };
    const child = spawn(args[0], args.slice(1), { env });
    child.stdout.on("data", (d: Buffer) => onStdout(d.toString()));
    child.stderr.on("data", (d: Buffer) => onStderr(d.toString()));
    child.on("exit", (code) => onExit(code));
    return { kill: () => child.kill("SIGTERM") };
  }

  async writeFile(p: string, content: string, mode?: number): Promise<void> {
    await this.makeDir(path.dirname(p));
    // Base64 over stdin avoids quoting pitfalls on remote shell.
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const target = `echo ${b64} | base64 -d > '${p}'` + (mode ? ` && chmod ${mode.toString(8)} '${p}'` : "");
    const res = await this.run(["bash", "-lc", target]);
    if (res.exitCode !== 0) {
      throw new Error(`Failed to write remote file ${p}: ${res.stderr}`);
    }
  }

  async readFile(p: string): Promise<string> {
    const res = await this.run(["cat", p]);
    if (res.exitCode !== 0) throw new Error(`Failed to read remote file ${p}`);
    return res.stdout;
  }

  async makeDir(p: string): Promise<void> {
    const res = await this.run(["mkdir", "-p", p]);
    if (res.exitCode !== 0) throw new Error(`Failed to mkdir ${p}`);
  }

  async exists(p: string): Promise<boolean> {
    const res = await this.run(["test", "-e", p, "&&", "echo", "yes", "||", "echo", "no"]);
    return res.stdout.trim() === "yes";
  }
}

/** Best-effort hostname detection used to tell whether a node is the panel host. */
export function isLoopback(host: string): boolean {
  return ["127.0.0.1", "::1", "localhost", "local", "self", "0.0.0.0"].includes(
    host.trim().toLowerCase(),
  );
}
