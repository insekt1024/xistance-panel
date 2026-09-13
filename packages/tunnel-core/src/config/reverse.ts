import type { ReverseConfig, SshConfig } from "@xistance/types";

// ---------------------------------------------------------------------------
// REVERSE tunnel — one-click ssh -R reverse forward with autossh resilience.
// Pure mapping (no I/O): the engine resolves the ssh/autossh binaries on the
// Iran node and runs the resulting command there, exactly like SSH tunnels.
// ---------------------------------------------------------------------------

/** Map a REVERSE config onto the equivalent SSH remote-forward config. */
export function reverseToSshConfig(cfg: ReverseConfig, fallbackHost: string): SshConfig {
  return {
    mode: "remote",
    host: cfg.host.trim() ? cfg.host : fallbackHost,
    port: cfg.port,
    username: cfg.username,
    auth: cfg.auth,
    key: cfg.key,
    password: cfg.password,
    localBindAddr: "127.0.0.1",
    // -R [remoteBind:]remotePort:localHost:localPort: expose listenPort on
    // the Foreign side, backed by forwardHost:forwardPort on the Iran side.
    localPort: cfg.forwardPort,
    remoteHost: cfg.forwardHost,
    remotePort: cfg.listenPort,
    remoteBindAddr: cfg.remoteBindAddr,
    dynamicBindAddr: "127.0.0.1",
    extraArgs: [],
    useAutossh: cfg.useAutossh,
    autosshMonitorPort: cfg.autosshMonitorPort,
    autosshPoll: cfg.autosshPoll,
  };
}
