import type { XrayConfig } from "@xistance/types";

// ---------------------------------------------------------------------------
// XRAY tunnel — minimal xray-core client config.
// Inbound: dokodemo-door on listenPort (accepts local app traffic).
// Outbound: single VLESS/VMess/Trojan/Shadowsocks outbound pointing at the
// upstream (e.g. an inbound created in X-UI / 3X-UI). WS/gRPC + TLS/Reality
// map to streamSettings. Paste credentials from 3X-UI; panel writes JSON.
// Run: xray run -c <cfgDir>/xray.json
// ---------------------------------------------------------------------------

function outboundSettings(cfg: XrayConfig): Record<string, unknown> {
  const server = { address: cfg.address, port: cfg.port };
  switch (cfg.protocol) {
    case "vless":
      return {
        vnext: [
          {
            ...server,
            users: [{ id: cfg.uuid, flow: cfg.flow || undefined, encryption: "none" }],
          },
        ],
      };
    case "vmess":
      return {
        vnext: [{ ...server, users: [{ id: cfg.uuid, security: "auto" }] }],
      };
    case "trojan":
      return {
        servers: [{ ...server, password: cfg.uuid }],
      };
    case "shadowsocks":
      return {
        servers: [{ ...server, method: "aes-256-gcm", password: cfg.uuid }],
      };
    default: {
      const exhaustive: never = cfg.protocol;
      throw new Error(`Unsupported Xray protocol: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function streamSettings(cfg: XrayConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { network: cfg.network };
  if (cfg.security !== "none") out.security = cfg.security;
  if (cfg.network === "ws") out.wsSettings = { path: cfg.path || "/", headers: cfg.sni ? { Host: cfg.sni } : {} };
  if (cfg.network === "grpc") out.grpcSettings = { serviceName: cfg.path || "xistance" };
  if (cfg.security === "tls" || cfg.security === "reality") {
    out.tlsSettings = { serverName: cfg.sni || cfg.address, allowInsecure: false };
  }
  return out;
}

export function buildXrayConfig(cfg: XrayConfig): string {
  const doc = {
    log: { loglevel: "warning" },
    inbounds: [
      {
        tag: "xistance-in",
        port: cfg.listenPort,
        protocol: "dokodemo-door",
        settings: { network: "tcp,udp", followRedirect: false },
        sniffing: { enabled: true, destOverride: ["http", "tls"] },
      },
    ],
    outbounds: [
      {
        tag: "xistance-out",
        protocol: cfg.protocol,
        settings: outboundSettings(cfg),
        streamSettings: streamSettings(cfg),
      },
      { tag: "direct", protocol: "freedom" },
    ],
    routing: { rules: [{ type: "field", inboundTag: ["xistance-in"], outboundTag: "xistance-out" }] },
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

export function buildXrayCommand(cfgPath: string): string[] {
  return ["xray", "run", "-c", cfgPath];
}

export const XRAY_BINARY = "xray";
