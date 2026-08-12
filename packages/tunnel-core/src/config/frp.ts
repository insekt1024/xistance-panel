import type { FrpClientConfig, FrpServerConfig, FrpProxy } from "@xistance/types";

// ---------------------------------------------------------------------------
// FRP (fatedier/frp) config generation (TOML).
// frps runs on the Foreign node; frpc on the Iran node.
// ---------------------------------------------------------------------------

function tomlQuote(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function buildFrpServerConfig(cfg: FrpServerConfig): string {
  const lines: string[] = [];
  lines.push(`bindPort = ${cfg.bindPort}`);
  if (cfg.bindUdpPort) lines.push(`bindUdpPort = ${cfg.bindUdpPort}`);
  lines.push(`auth.token = ${tomlQuote(cfg.token)}`);
  if (cfg.dashboard.enabled) {
    lines.push(
      "[webServer]",
      "addr = \"127.0.0.1\"",
      `port = ${cfg.dashboard.port ?? 17500}`,
      `user = ${tomlQuote(cfg.dashboard.user ?? "admin")}`,
      `password = ${tomlQuote(cfg.dashboard.password ?? "")}`,
    );
    if (cfg.allowPorts?.length) {
      lines.push(`allowPorts = [${cfg.allowPorts.join(", ")}]`);
    }
  }
  return lines.join("\n") + "\n";
}

function proxyBlock(p: FrpProxy): string {
  const lines: string[] = [
    `[[proxies]]`,
    `name = ${tomlQuote(p.name)}`,
    `type = ${tomlQuote(p.type)}`,
  ];
  if (p.role === "server") {
    if (p.secretKey) lines.push(`secretKey = ${tomlQuote(p.secretKey)}`);
    if (p.localIP) lines.push(`localIP = ${tomlQuote(p.localIP)}`);
    if (p.localPort) lines.push(`localPort = ${p.localPort}`);
  } else if (p.role === "visitor") {
    lines.push(`serverName = ${tomlQuote(p.serverName ?? p.name)}`);
    if (p.secretKey) lines.push(`secretKey = ${tomlQuote(p.secretKey)}`);
  } else {
    if (p.localIP) lines.push(`localIP = ${tomlQuote(p.localIP)}`);
    if (p.localPort) lines.push(`localPort = ${p.localPort}`);
    if (p.customDomains?.length) {
      lines.push(`customDomains = [${p.customDomains.map(tomlQuote).join(", ")}]`);
    }
    if (p.remotePort) lines.push(`remotePort = ${p.remotePort}`);
  }
  lines.push(
    "[proxies.transport]",
    `useEncryption = ${p.transport.encryption}`,
    `useCompression = ${p.transport.compression}`,
  );
  if (p.transport.bandwidthLimit) {
    lines.push(`bandwidthLimit = ${tomlQuote(p.transport.bandwidthLimit)}`);
  }
  if (p.plugin?.type) {
    lines.push(
      "[proxies.plugin]",
      `type = ${tomlQuote(p.plugin.type)}`,
      `addr = ${tomlQuote(p.plugin.addr ?? "")}`,
      `port = ${p.plugin.port ?? 0}`,
    );
  }
  return lines.join("\n");
}

export function buildFrpClientConfig(cfg: FrpClientConfig): string {
  const lines: string[] = [
    `serverAddr = ${tomlQuote(cfg.serverAddr)}`,
    `serverPort = ${cfg.serverPort}`,
    `auth.token = ${tomlQuote(cfg.token)}`,
    "",
  ];
  for (const p of cfg.proxies) lines.push(proxyBlock(p));
  return lines.join("\n") + "\n";
}

/** Produce both frps (server) and frpc (client) TOML from a tunnel config. */
export function buildFrpPair(
  cfg: { bindPort: number; bindUdpPort?: number; token: string; dashboard?: { enabled?: boolean; port?: number; user?: string; password?: string }; allowPorts?: string[]; proxies: FrpProxy[] },
  serverAddr: string,
): { server: string; client: string } {
  const server: FrpServerConfig = {
    role: "server",
    bindPort: cfg.bindPort,
    bindUdpPort: cfg.bindUdpPort,
    token: cfg.token,
    dashboard: { enabled: cfg.dashboard?.enabled ?? false, port: cfg.dashboard?.port, user: cfg.dashboard?.user, password: cfg.dashboard?.password },
    allowPorts: cfg.allowPorts,
  };
  const client: FrpClientConfig = {
    role: "client",
    serverAddr,
    serverPort: cfg.bindPort,
    token: cfg.token,
    proxies: cfg.proxies,
  };
  return {
    server: buildFrpServerConfig(server),
    client: buildFrpClientConfig(client),
  };
}

export const FRP_CLIENT_FILE = "frpc";
export const FRP_SERVER_FILE = "frps";