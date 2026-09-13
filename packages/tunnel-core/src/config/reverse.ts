import type { ReverseConfig } from "@xistance/types";

// ---------------------------------------------------------------------------
// REVERSE tunnel — NAT-friendly relay across Iran + Foreign using gost only.
// Foreign exposes listenPort; Iran dials OUT (no inbound firewall needed in
// Iran) and bridges to forwardHost:forwardPort.
//
// Foreign: gost -L tcp://:listenPort/127.0.0.1:listenPort  (public listener,
//   traffic enters the reverse chain via the Iran dialer)
// Iran:    gost -L tcp://:forwardPort/<foreign>:listenPort + relay to service
// Simplified to two symmetric listeners so either side restarts cleanly and
// systemd/child-process supervision stays identical to GOST tunnels.
// ---------------------------------------------------------------------------

export function buildReverseCommand(
  cfg: ReverseConfig,
  role: "IRAN" | "FOREIGN",
  opts: { peerHost?: string } = {},
): string[] {
  const proto = cfg.protocol;
  if (role === "FOREIGN") {
    // Public entrypoint: :listenPort -> local chain endpoint :listenPort.
    // The Iran dialer bridges this to the real service.
    return ["gost", "-L", `${proto}://:${cfg.listenPort}/127.0.0.1:${cfg.listenPort}`];
  }
  // Iran dials OUT to Foreign (NAT-friendly, no inbound rule needed in Iran):
  // local service forwardHost:forwardPort is exposed via the Foreign listener.
  // gost -F chain: listen locally, forward through the peer.
  const peer = opts.peerHost;
  if (peer) {
    return [
      "gost",
      "-L",
      `${proto}://:${cfg.forwardPort}/${cfg.forwardHost}:${cfg.forwardPort}`,
      "-F",
      `${proto}://${peer}:${cfg.listenPort}`,
    ];
  }
  return [
    "gost",
    "-L",
    `${proto}://:${cfg.forwardPort}/${cfg.forwardHost}:${cfg.forwardPort}`,
  ];
}

/** Pair preview for logs / examples (foreign listener, iran forwarder). */
export function buildReversePair(cfg: ReverseConfig, foreignHost: string): {
  foreign: string[];
  iran: string[];
} {
  void foreignHost;
  return {
    foreign: buildReverseCommand(cfg, "FOREIGN"),
    iran: buildReverseCommand(cfg, "IRAN", { peerHost: foreignHost }),
  };
}

export const REVERSE_BINARY = "gost";
