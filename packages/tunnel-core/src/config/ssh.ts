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

export function buildSshCommand(
  cfg: SshConfig,
  opts: { keyPath?: string; password?: string },
): string[] {
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
