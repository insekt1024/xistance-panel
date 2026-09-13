import type { DirectConfig } from "@xistance/types";

// ---------------------------------------------------------------------------
// DIRECT tunnel — single-node forward, zero peer coupling.
// Runs: gost -L <proto>://<bindAddr>:<listenPort>/<targetHost>:<targetPort>
// No outbound dial, no token, minimal RAM (~5MB). Pick the node closest to
// the target service (usually the Foreign node).
// ---------------------------------------------------------------------------

export function buildDirectCommand(cfg: DirectConfig): string[] {
  const bind = cfg.bindAddr && cfg.bindAddr !== "0.0.0.0" ? cfg.bindAddr : "";
  const listen = bind ? `${bind}:${cfg.listenPort}` : `:${cfg.listenPort}`;
  return ["gost", "-L", `${cfg.protocol}://${listen}/${cfg.targetHost}:${cfg.targetPort}`];
}

export const DIRECT_BINARY = "gost";
