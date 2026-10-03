import type { SshConfig } from "@xistance/types";

// ---------------------------------------------------------------------------
// SSH tunnel command builder (local / remote / dynamic forwarding).
// Runs through the system OpenSSH client (install.sh installs openssh-client +
// sshpass). Keys are materialised to a private file by the engine and passed
// with -i; passwords are supplied via sshpass (SPAWNED_BY_XISTANCE).
// ---------------------------------------------------------------------------

const SSH_BASE = [
  "ssh",
  "-N",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "ExitOnForwardFailure=yes",
  "-o",
  "StrictHostKeyChecking=accept-new",
];

// ---------------------------------------------------------------------------
// Destination validation.
//
// The destination reaches ssh as the argv token `${username}@${host}`. ssh
// parses ANY leading-dash argv token as an OPTION before it ever looks for a
// destination, so an unvalidated username of
// `-oProxyCommand=touch /tmp/pwned` produced the final token
// `-oProxyCommand=touch /tmp/pwned@10.0.0.5` -- arbitrary command execution on
// the panel host. It also bypassed the extraArgs allowlist entirely, because
// the payload never passed through extraArgs.
//
// Refused here: anything that could be read as an option (a leading dash), any
// shell metacharacter, whitespace or control characters, an embedded @ (which
// would make the user@host split ambiguous), and the empty/blank cases. What
// remains is a hostname, IPv4/IPv6 literal, or POSIX username.
// ---------------------------------------------------------------------------

const SSH_USERNAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;
const SSH_HOST = /^[A-Za-z0-9_][A-Za-z0-9.:_-]{0,252}$/;

/** Validate a username/host pair for safe use in an ssh destination token. */
export function assertSafeSshDestination(username: string, host: string): void {
  if (typeof username !== "string" || !SSH_USERNAME.test(username)) {
    throw new Error(
      `Invalid SSH username: ${JSON.stringify(username)}. ` +
        `Use 1-32 characters matching [A-Za-z0-9._-], starting alphanumeric or underscore.`,
    );
  }
  if (typeof host !== "string" || !SSH_HOST.test(host)) {
    throw new Error(
      `Invalid SSH host: ${JSON.stringify(host)}. ` +
        `Use a hostname or IP literal, 1-253 characters matching [A-Za-z0-9.:_-].`,
    );
  }
  // Belt and braces: the regexes already exclude these, but the rule that
  // matters is stated where the destination is built.
  if (username.startsWith("-") || host.startsWith("-")) {
    throw new Error("Invalid SSH destination: a value starting with '-' would be parsed as an ssh option");
  }
}

/**
 * Validate a value that is SPLICED into an `-L`/`-R`/`-D` token.
 *
 * `assertSafeSshDestination` guards only the `user@host` destination, because
 * that is where ssh parses options. These five fields end up inside a single
 * forward token instead, where a delimiter or a leading "-" silently changes the
 * meaning of the argument -- and nothing catches it: the token is passed as one
 * argv element, so ssh takes it as opaque data and binds a port that forwards to
 * nothing. Same failure shape as the GOST half-address (TASK-131): the tunnel
 * reports itself running and carries no traffic.
 *
 * REVERSE reaches these fields through reverseToSshConfig, so this also covers
 * it. The schema holds all five to hostLikeAddress; this is the layer that
 * holds when a caller bypasses the schema, as DIRECT's assertSafeDirectAddress
 * does.
 */
export function assertSafeForwardField(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Invalid SSH ${field}: it must not be empty (it is spliced into a -L/-R/-D argument)`,
    );
  }
  if (value !== value.trim()) {
    throw new Error(`Invalid SSH ${field}: leading or trailing whitespace is not allowed`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid SSH ${field}: whitespace and control characters are not allowed`);
  }
  // Scheme FIRST, for the same reason as assertSafeDirectAddress: "tcp://1.2.3.4"
  // contains "//", and reporting it as a delimiter problem tells the operator
  // nothing about what to change.
  if (value.includes("://")) {
    throw new Error(`Invalid SSH ${field}: do not include a scheme, pass a bare address`);
  }
  if (/[/\\?#@]/.test(value)) {
    throw new Error(
      `Invalid SSH ${field}: must not contain a URL delimiter (/ \\ ? # @) -- ` +
        `it would change which host this argument forwards to`,
    );
  }
  if (value.startsWith("-")) {
    throw new Error(
      `Invalid SSH ${field}: must not start with '-' -- it would be parsed as an ssh option`,
    );
  }
}

export function buildSshCommand(
  cfg: SshConfig,
  opts: { keyPath?: string; password?: string },
): string[] {
  assertSafeSshDestination(cfg.username, cfg.host);
  // Every field below lands inside ONE forward token, so all of them are checked
  // before any of them is spliced.
  assertSafeForwardField(cfg.localBindAddr, "localBindAddr");
  assertSafeForwardField(cfg.remoteHost, "remoteHost");
  assertSafeForwardField(cfg.remoteBindAddr, "remoteBindAddr");
  assertSafeForwardField(cfg.dynamicBindAddr, "dynamicBindAddr");
  const args: string[] = [...SSH_BASE];
  if (opts.keyPath) args.push("-i", opts.keyPath);

  if (cfg.mode === "local") {
    args.push(
      "-L",
      `${cfg.localBindAddr}:${cfg.localPort}:${cfg.remoteHost}:${cfg.remotePort}`,
    );
  } else if (cfg.mode === "remote") {
    args.push("-R", `${cfg.remoteBindAddr}:${cfg.remotePort}:${cfg.remoteHost}:${cfg.localPort}`);
  } else if (cfg.mode === "dynamic") {
    args.push("-D", `${cfg.dynamicBindAddr}:${cfg.localPort}`);
  } else {
    throw new Error(`Unsupported SSH mode: ${(cfg as SshConfig).mode}`);
  }

  args.push(`-p`, String(cfg.port), `${cfg.username}@${cfg.host}`);
  // Defense in depth: only allow a small set of harmless -o options even if
  // a caller bypasses schema validation. Anything else is dropped silently.
  for (const extra of filterExtraArgs(cfg.extraArgs ?? [])) args.push(extra);

  return args;
}

// Safe -o keys: numeric/boolean/enum values only. Notably EXCLUDED:
// ProxyCommand, LocalCommand, PermitLocalCommand, ForwardAgent,
// ForwardX11, IdentityFile, IdentityAgent, ControlPath, Match, Include.
const SAFE_SSH_OPTIONS = new Set([
  "Compression",
  "ConnectTimeout",
  "ConnectionAttempts",
  "ExitOnForwardFailure",
  "LogLevel",
  "ServerAliveCountMax",
  "ServerAliveInterval",
  "StrictHostKeyChecking",
  "TCPKeepAlive",
]);

const SAFE_SSH_VALUE = /^[A-Za-z0-9._-]+$/;

export function filterExtraArgs(extras: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < extras.length; i++) {
    const arg = extras[i];
    // Only accept pairs shaped exactly like: "-o", "Key=Value"
    if (arg !== "-o" || i + 1 >= extras.length) continue;
    const kv = extras[i + 1];
    const eq = kv.indexOf("=");
    if (eq <= 0) continue;
    const key = kv.slice(0, eq);
    const value = kv.slice(eq + 1);
    if (!SAFE_SSH_OPTIONS.has(key)) continue;
    if (!SAFE_SSH_VALUE.test(value)) continue;
    out.push("-o", `${key}=${value}`);
    i++; // consumed the value
  }
  return out;
}

/** True if the tunnel requires the sshpass wrapper to supply a password. */
export function sshRequiresPass(cfg: SshConfig): boolean {
  return cfg.auth === "password" && Boolean(cfg.password);
}

// ---------------------------------------------------------------------------
// autossh command builder. autossh wraps the ssh client and restarts it
// whenever the connection drops, giving SSH tunnels the same resilience the
// engine's other tunnel methods already rely on. The ssh arguments are
// identical to buildSshCommand (minus the leading "ssh" token); autossh's own
// -M monitor-port flag is prepended.
//
// The engine must supply AUTOSSH_GATETIME=0 (don't wait 30s before monitoring
// kicks in — lets systemd report a clean startup immediately), AUTOSSH_POLL
// and AUTOSSH_LOGLEVEL via the ProcessSpec env (see engine.planSsh).
// ---------------------------------------------------------------------------

export function buildAutosshCommand(
  cfg: SshConfig,
  opts: { keyPath?: string; password?: string },
): string[] {
  const sshArgs = buildSshCommand(cfg, opts);
  // Drop the leading "ssh" token; autossh supplies its own program name.
  const [, ...rest] = sshArgs;
  const monitorPort = cfg.autosshMonitorPort ?? 0;
  return ["autossh", "-M", String(monitorPort), ...rest];
}
