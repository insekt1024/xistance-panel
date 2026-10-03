import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { assertSafeSshDestination } from "./config/ssh.js";

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

  /**
   * Write by rename, never in place.
   *
   * `fs.writeFile` opens with O_TRUNC, so a concurrent reader -- an xray or
   * gost process re-reading its config, or a second deploy -- can observe the
   * file between the truncate and the last write. For JSON that means a
   * truncated document: a crash loop, or worse, a config that still parses but
   * has lost its outbounds.
   *
   * Writing a sibling temp file and renaming it over the target makes the
   * replacement atomic on POSIX and on Windows: a reader either sees the whole
   * previous file or the whole new one, never a prefix of either.
   */
  async writeFile(p: string, content: string, mode?: number): Promise<void> {
    const dir = path.dirname(p);
    await fs.mkdir(dir, { recursive: true });
    // Same directory, so the rename stays on one filesystem and is therefore
    // atomic. A temp file in os.tmpdir() could cross a mount point.
    const tmp = path.join(dir, `.${path.basename(p)}.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.writeFile(tmp, content, mode ? { mode } : undefined);
      // rename() replaces the target on POSIX. On Windows it fails if the
      // target exists, so unlink first -- which reintroduces a window, hence
      // the retry below that restores the previous file if the unlink wins.
      await this.replaceFile(tmp, p);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  /** Platform-correct atomic-ish replace. */
  private async replaceFile(tmp: string, target: string): Promise<void> {
    try {
      await fs.rename(tmp, target);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw e;
      // Windows: rename will not clobber. Unlink and retry once.
      await fs.rm(target, { force: true });
      await fs.rename(tmp, target);
    }
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

/** Single-quote a string for POSIX sh (escapes embedded single quotes). */
function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'"'"'`)}'`;
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
    // The destination token is `${username}@${host}`. ssh parses ANY argv token
    // that begins with "-" as an OPTION before it ever looks for a destination,
    // so a username of `-oProxyCommand=<cmd>` made ssh execute that command on
    // the panel host. NodeConfigSchema now refuses such a username, but a
    // stored node predating that fix — or any caller that constructs an
    // SshConnection without going through the schema — must not reach ssh.
    // Re-check here, at the point the token is built.
    assertSafeSshDestination(this.conn.username, this.conn.host);
    // NOTE: BatchMode=yes must NOT be set for password auth — it disables
    // password/keyboard-interactive prompts, which breaks sshpass logins.
    // (Same rule as apps/web/app/api/nodes/[id]/test/route.ts.)
    const usePassword = this.conn.authMethod === "password" && Boolean(this.conn.password);
    return [
      ...sshPassPrefix(this.conn),
      "ssh",
      "-p",
      String(this.conn.port),
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "ConnectTimeout=15",
      ...(usePassword ? [] : ["-o", "BatchMode=yes"]),
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
    // Single `bash -lc` invocation: run() already wraps argv in one remote
    // `bash -lc '<cmd>'`, so passing ["bash","-lc",script] would double-wrap
    // (the outer shell would swallow the script as $0/$1 instead of running it).
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const target = shQuote(p);
    // Write to a sibling temp file and `mv` it into place. `> target` truncates
    // the live config first, so a tunnel process reading it during the write
    // sees a truncated JSON document. `mv` within one directory is a rename,
    // so the swap is atomic and the previous config survives a mid-write
    // failure. The temp name is quoted and lives in the same directory as the
    // target so the rename cannot cross a filesystem.
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    const modePart = mode ? ` && chmod ${mode.toString(8)} ${shQuote(tmp)}` : "";
    const script =
      `echo ${b64} | base64 -d > ${shQuote(tmp)}` +
      modePart +
      ` && mv -f ${shQuote(tmp)} ${target}`;
    const res = await this.runScript(script);
    if (res.exitCode !== 0) {
      // Best-effort cleanup so a failed write does not litter the config dir.
      await this.runScript(`rm -f ${shQuote(tmp)}`).catch(() => undefined);
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
    // Single-string form: `&&`/`||` must be parsed by ONE remote shell.
    // Passing them as separate argv elements would single-quote each one
    // remotely (always false). runScript() issues a single `bash -lc`.
    const res = await this.runScript(`test -e ${shQuote(p)} && echo yes || echo no`);
    return res.stdout.trim() === "yes";
  }

  /** Run an opaque shell script via a single remote `bash -lc` invocation. */
  private runScript(
    script: string,
    opts?: { timeoutMs?: number; env?: Record<string, string> },
  ): Promise<RunResult> {
    const args = this.baseArgs(script);
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
}

/** Best-effort hostname detection used to tell whether a node is the panel host. */
export function isLoopback(host: string): boolean {
  return ["127.0.0.1", "::1", "localhost", "local", "self", "0.0.0.0"].includes(
    host.trim().toLowerCase(),
  );
}
