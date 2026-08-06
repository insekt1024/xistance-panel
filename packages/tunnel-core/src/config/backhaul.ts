import type { BackhaulConfig } from "@xistance/types";

// ---------------------------------------------------------------------------
// Backhaul (Musixal/Backhaul) config generation (TOML).
//
// Layout: the *server* runs on the Foreign node (public listener); the *client*
// runs on the Iran node and dials out. portmap maps a local service to a public
// remote port. The format below targets Backhaul v3.x; install.sh pins a tested
// binary and validates the checksum.
// ---------------------------------------------------------------------------

function tomlQuote(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function bool(v: boolean): string {
  return v ? "true" : "false";
}

function portMapBlock(portMap: { local: number; remote: number }[]): string {
  const entries = portMap
    .map((p) => `  { local = ${tomlQuote(`127.0.0.1:${p.local}`)}, remote = ${tomlQuote(`0.0.0.0:${p.remote}`)} }`)
    .join(",\n");
  return `portmap = [\n${entries}\n]`;
}

export function buildBackhaulConfig(cfg: BackhaulConfig, role: "client" | "server"): string {
  const lines: string[] = [];
  if (role === "server") {
    lines.push("[server]", `listen = ${tomlQuote(`${cfg.listenAddress}:${cfg.listenPort}`)}`);
  } else {
    lines.push("[client]", `remote_addr = ${tomlQuote(`${cfg.remoteHost ?? ""}:${cfg.listenPort}`)}`);
  }
  lines.push(`token = ${tomlQuote(cfg.token)}`);
  lines.push(`transport = ${tomlQuote(cfg.transport)}`);
  if (cfg.portMap.length) lines.push(portMapBlock(cfg.portMap));
  lines.push("tcp_nodelay = true");
  lines.push("keepalive_period = 75");
  // multiplexing enabled via accept_mux on the server / reset_mux on the client
  if (role === "server") lines.push(`accept_mux = ${bool(cfg.multiplexing)}`);
  else lines.push(`reset_mux = ${bool(!cfg.multiplexing)}`);
  lines.push(`heartbeat = ${cfg.heartbeat}`);
  lines.push(`channel_size = ${cfg.channelSize}`);
  return lines.join("\n") + "\n";
}

/** Backhaul binary path (renamed to a stable name in the tunnels/bin dir). */
export const BACKHAUL_CLIENT_FILE = "backhaul";
export const BACKHAUL_SERVER_FILE = "backhaul";