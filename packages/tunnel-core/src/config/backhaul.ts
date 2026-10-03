import type { BackhaulConfig } from "@xistance/types";

// ---------------------------------------------------------------------------
// Backhaul (Musixal/Backhaul) v0.7.x config generation (TOML).
//
// Layout: the *server* runs on the Foreign node (public listener) and lists the
// exposed ports (`ports = ["<remote>=<local>"]`); the *client* runs on the Iran
// node, dials the server control channel and connects tunneled traffic to the
// local service. `install.sh` pins a tested binary and validates the checksum.
// ---------------------------------------------------------------------------

/**
 * Quote a value for a TOML basic string.
 *
 * Backslash and double-quote were escaped, but a raw newline passed through
 * untouched. A token containing one therefore terminated the line and the
 * following text was parsed as TOML -- a config-injection primitive via a
 * field the user supplies. Control characters are rejected outright rather than
 * escaped, because none of them are legitimate in a token, host or port value
 * and silently rewriting one would be worse than refusing it.
 */
function tomlQuote(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) {
    throw new Error(
      "Backhaul config value contains a control character, which cannot be represented in TOML",
    );
  }
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Map our transport to Backhaul's transport token (multiplexing -> *mux). */
function transportName(cfg: BackhaulConfig): string {
  const base: Record<string, string> = {
    tcp: "tcp",
    websocket: "ws",
    quic: "tcp", // v0.7.x has no quic/udp transport; fall back to tcp.
  };
  const t = base[cfg.transport] ?? "tcp";
  return cfg.multiplexing && t === "tcp" ? "tcpmux" : cfg.multiplexing && t === "ws" ? "wsmux" : t;
}

/** Server `ports` entries: "<exposedRemotePort>=<localServicePort>". */
function portsBlock(portMap: { local: number; remote: number }[]): string {
  const entries = portMap.map((p) => tomlQuote(`${p.remote}=${p.local}`));
  return `ports = [${entries.join(", ")}]`;
}

export function buildBackhaulConfig(cfg: BackhaulConfig, role: "client" | "server"): string {
  const lines: string[] = [];
  if (role === "server") {
    lines.push(
      "[server]",
      `bind_addr = ${tomlQuote(`${cfg.listenAddress}:${cfg.listenPort}`)}`,
    );
  } else {
    lines.push("[client]", `remote_addr = ${tomlQuote(`${cfg.remoteHost ?? "127.0.0.1"}:${cfg.listenPort}`)}`);
  }
  lines.push(`transport = ${tomlQuote(transportName(cfg))}`);
  lines.push(`token = ${tomlQuote(cfg.token)}`);
  if (role === "server") {
    if (cfg.portMap.length) lines.push(portsBlock(cfg.portMap));
    lines.push("nodelay = true");
    lines.push("keepalive_period = 75");
    lines.push(`heartbeat = ${cfg.heartbeat}`);
    lines.push(`channel_size = ${cfg.channelSize}`);
    if (cfg.muxConcurrency) lines.push(`mux_con = ${cfg.muxConcurrency}`);
  } else {
    lines.push("connection_pool = 8");
    lines.push("keepalive_period = 75");
    lines.push("nodelay = true");
    lines.push("retry_interval = 3");
    lines.push("dial_timeout = 10");
  }
  lines.push('log_level = "info"');
  return lines.join("\n") + "\n";
}

/** Backhaul binary path (renamed to a stable name in the tunnels/bin dir). */
export const BACKHAUL_CLIENT_FILE = "backhaul";
export const BACKHAUL_SERVER_FILE = "backhaul";