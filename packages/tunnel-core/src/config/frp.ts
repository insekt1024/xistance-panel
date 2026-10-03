import type { FrpClientConfig, FrpServerConfig, FrpProxy } from "@xistance/types";

// ---------------------------------------------------------------------------
// FRP (fatedier/frp) config generation (TOML).
// frps runs on the Foreign node; frpc on the Iran node.
// ---------------------------------------------------------------------------

/**
 * Quote a value for a TOML basic string.
 *
 * Same control-character rejection as backhaul.ts: escaping only backslash and
 * double-quote let a raw newline through, which terminates the line and lets
 * the following text be parsed as TOML. FRP configs carry auth tokens, so this
 * is the same injection primitive in the same class of file.
 */
function tomlQuote(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) {
    throw new Error(
      "FRP config value contains a control character, which cannot be represented in TOML",
    );
  }
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * Emit one entry of frps's `allowPorts` as a TOML inline table.
 *
 * frps types this key as `[]types.PortsRange` -- an array of `{start, end}`
 * objects. Emitting the schema's plain strings makes frps ABORT at startup:
 *
 *   field "allowPorts": cannot unmarshal string into types.PortsRange
 *
 * so the Foreign node never binds its control port and every FRP tunnel fails
 * to come up. Verified against frps 0.70.1, the version pinned in
 * scripts/install.sh; strings, bare numbers and a bare object are all refused,
 * only `[{ start = N, end = N }]` starts.
 *
 * A malformed range throws here rather than emitting a config frps will reject,
 * so the operator gets a diagnosable error instead of a dead tunnel.
 */
function portsRange(spec: string): string {
  const m = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(spec.trim());
  if (!m) {
    throw new Error(`FRP allowPorts entry "${spec}" is not a port or port range`);
  }
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (start < 1 || end > 65535 || start > end) {
    throw new Error(`FRP allowPorts entry "${spec}" is not a valid port range`);
  }
  return `{ start = ${start}, end = ${end} }`;
}

export function buildFrpServerConfig(cfg: FrpServerConfig): string {
  const lines: string[] = [];
  lines.push(`bindPort = ${cfg.bindPort}`);
  if (cfg.bindUdpPort) lines.push(`bindUdpPort = ${cfg.bindUdpPort}`);
  lines.push(`auth.token = ${tomlQuote(cfg.token)}`);
  // allowPorts is a TOP-LEVEL frps key. It was emitted after the [webServer]
  // table header, so TOML scoping put it at webServer.allowPorts and frps
  // ignored it entirely -- the port allowlist silently did nothing. It must be
  // written before any table header. Values are {start,end} ranges, see
  // portsRange() above for why quoting them is fatal.
  if (cfg.allowPorts?.length) {
    lines.push(`allowPorts = [${cfg.allowPorts.map(portsRange).join(", ")}]`);
  }
  if (cfg.dashboard.enabled) {
    lines.push(
      "[webServer]",
      "addr = \"127.0.0.1\"",
      `port = ${cfg.dashboard.port ?? 17500}`,
      `user = ${tomlQuote(cfg.dashboard.user ?? "admin")}`,
      `password = ${tomlQuote(cfg.dashboard.password ?? "")}`,
    );
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
    // Only `type` goes here. TASK-132: `addr` and `port` were emitted alongside
    // it, and frpc 0.70.1 -- the version install.sh pins -- REJECTS both as
    // unknown fields (exit 1), so any proxy configured with a plugin could not
    // start at all.
    //
    //   [proxies.plugin] type only         -> "syntax is ok", exit 0
    //   + addr = "127.0.0.1"              -> unknown field "addr", exit 1
    //   + port = 3128                     -> unknown field "addr", exit 1
    //   + [proxies.plugin.params]         -> unknown field "params", exit 1
    //
    // `addr`/`port`/`user` are real frp fields, but they belong to the
    // PER-PLUGIN option structs (HTTPProxyPluginOptions and friends), not to
    // ClientPluginOptions, which carries `type` alone. Verified against the
    // pinned binary's own type table.
    lines.push("[proxies.plugin]", `type = ${tomlQuote(p.plugin.type)}`);
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