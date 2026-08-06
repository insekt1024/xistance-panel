import type { GostConfig } from "@xistance/types";

// ---------------------------------------------------------------------------
// GOST (Go Simple Tunnel) — "Paqet / Packet" relay.
//
// Model: each side runs `gost -L <proto>://[addr]:port/host:port`. The Iran node
// relays local listeners to a foreign target; for a tunneled UDP/TCP chain an
// optional socks5 relay hop can be used when direct connectivity is blocked.
// Congestion of the config schema is documented in packages/types.
// ---------------------------------------------------------------------------

function listenerTarget(cfg: GostConfig): string {
  return `${cfg.forwardHost ?? ""}:${cfg.forwardPort ?? ""}`;
}

/**
 * Build the gost command for a given node role.
 * Returns null when the node is not participating for this config.
 */
export function buildGostCommand(cfg: GostConfig, role: "IRAN" | "FOREIGN"): string[] | null {
  const proto = cfg.protocol;
  // Single relay: only one listener host is configured; the node that owns the
  // source port runs the relay and forwards to the target on the other side.
  if (!cfg.bidirectional) {
    const isListenerNode = cfg.direction === role;
    if (!isListenerNode) return null;
    const listen = `-L ${proto}://:${cfg.listenPort}/${listenerTarget(cfg)}`;
    const args = [listen];
    if (cfg.udpDataBufferSize) args.push(`-udpDataBufferSize=${cfg.udpDataBufferSize}`);
    return ["gost", ...args];
  }

  // Bidirectional: both sides relay each other's ports.
  const listen = `-L ${proto}://:${cfg.listenPort}/${listenerTarget(cfg)}`;
  return ["gost", listen];
}

export function buildGostForwardArgs(cfg: GostConfig): {
  localHost: string;
  localPort: number;
  forwardHost: string | undefined;
  forwardPort: number | undefined;
  protocol: "tcp" | "udp";
} {
  return {
    localHost: "0.0.0.0",
    localPort: cfg.listenPort,
    forwardHost: cfg.forwardHost,
    forwardPort: cfg.forwardPort,
    protocol: cfg.protocol,
  };
}

export const GOST_BINARY = "gost";
