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
  for (const extra of cfg.extraArgs ?? []) args.push(extra);

  return args;
}

/** True if the tunnel requires the sshpass wrapper to supply a password. */
export function sshRequiresPass(cfg: SshConfig): boolean {
  return cfg.auth === "password" && Boolean(cfg.password);
}