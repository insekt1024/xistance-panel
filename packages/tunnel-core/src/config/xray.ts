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
  if (cfg.security === "reality") {
    // Reality needs its own settings block. Emitting a bare `security:
    // "reality"` with only tlsSettings produces a config xray rejects at
    // startup with an error that does not name the missing field. The schema
    // requires publicKey, so it is always present here.
    out.realitySettings = {
      serverName: cfg.sni || cfg.address,
      publicKey: cfg.publicKey,
      fingerprint: cfg.fingerprint || "chrome",
      shortId: cfg.shortId || "",
      spiderX: "/",
    };
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
        // followRedirect MUST be true for this inbound.
        //
        // dokodemo-door has no `address` here, so the destination comes from the
        // connection. A transparent deployment (iptables REDIRECT, or TPROXY) captures
        // the app's connection and rewrites the destination to this port; xray
        // recovers the ORIGINAL destination only by reading SO_ORIGINAL_DST, which
        // is exactly what followRedirect enables.
        //
        // With false, dokodemo uses the POST-redirect destination -- the inbound's own
        // port -- so it dials ITSELF. Measured on the target OS (TASK-125):
        //   followRedirect: false  ->  accepted tcp:127.0.0.1:18082   (its own port)
        //   followRedirect: true   ->  accepted tcp:127.0.0.1:19098   (the real origin)
        // and `curl` returned http=000 in the first case, HELLO-XR in the second.
        //
        // TASK-125 initially recorded this as an artifact of a REDIRECT I had added
        // for testing. That framing was wrong: the loop follows from the shipped
        // config under ANY standard dokodemo deployment. `false` would only be
        // correct with TPROXY, which preserves the destination at socket level, and
        // the repo installs neither REDIRECT nor TPROXY.
        settings: { network: "tcp,udp", followRedirect: true },
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
