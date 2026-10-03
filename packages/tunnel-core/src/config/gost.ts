import type { GostConfig } from "@xistance/types";

// ---------------------------------------------------------------------------
// GOST (Go Simple Tunnel) — "Paqet / Packet" relay.
//
// Model: each side runs `gost -L <proto>://[addr]:port/host:port`. The Iran node
// relays local listeners to a foreign target; for a tunneled UDP/TCP chain an
// optional socks5 relay hop can be used when direct connectivity is blocked.
// Congestion of the config schema is documented in packages/types.
// ---------------------------------------------------------------------------

/**
 * Splice the relay target into one `host:port` fragment of the listener token.
 *
 * There are deliberately no `?? ""` fallbacks here any more. With them, a config
 * that reached the builder without a target produced `tcp://:9000/:` -- and gost
 * does not reject that. It starts, listens, accepts every connection and refuses
 * all of them with `dial tcp :0: connect: connection refused`, so the tunnel
 * reported itself running while carrying nothing.
 *
 * GostConfigSchema now requires the pair (the API and the wizard both validate
 * through it), and this throws rather than emitting a half-address if a caller
 * ever bypasses that -- the same defence-in-depth shape DIRECT and SSH use.
 */
function listenerTarget(cfg: GostConfig): string {
  if (!cfg.forwardHost || !cfg.forwardPort) {
    throw new Error(
      `GOST needs a complete relay target: got forwardHost=${JSON.stringify(cfg.forwardHost)}, ` +
        `forwardPort=${JSON.stringify(cfg.forwardPort)}`,
    );
  }
  return `${cfg.forwardHost}:${cfg.forwardPort}`;
}

/**
 * Build the gost command for a given node role.
 * Returns null when the node is not participating for this config.
 *
 * Targets gost v2.x CLI where each listener is passed as a separate token:
 *   gost -L <proto>://:[port]/[host]:[port]
 *
 * Single relay: only the node that owns `direction` runs a listener that
 * forwards to the configured target.
 *
 * Bidirectional: both nodes relay each other. The `direction` node listens on
 * `listenPort` and forwards to `forwardHost:forwardPort`; the peer node listens
 * on `remotePort` and forwards back to this node's listener (`peerHost:listenPort`).
 */
export function buildGostCommand(
  cfg: GostConfig,
  role: "IRAN" | "FOREIGN",
  opts: { peerHost?: string; peerPort?: number } = {},
): string[] | null {
  const proto = cfg.protocol;

  if (cfg.bidirectional) {
    if (role === cfg.direction) {
      return ["gost", "-L", `${proto}://:${cfg.listenPort}/${listenerTarget(cfg)}`];
    }
    // Mirrored side: listen on remotePort, forward to the peer's listener.
    const listenPort = cfg.remotePort ?? cfg.listenPort;
    const peerHost = opts.peerHost ?? cfg.forwardHost;
    const peerPort = opts.peerPort ?? cfg.listenPort;
    return ["gost", "-L", `${proto}://:${listenPort}/${peerHost}:${peerPort}`];
  }

  const isListenerNode = cfg.direction === role;
  if (!isListenerNode) return null;
  return ["gost", "-L", `${proto}://:${cfg.listenPort}/${listenerTarget(cfg)}`];
}

export function buildGostForwardArgs(cfg: GostConfig): {
  localHost: string;
  localPort: number;
  forwardHost: string;
  forwardPort: number;
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
