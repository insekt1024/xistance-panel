import path from "node:path";
import { TunnelEngine } from "@xistance/tunnel-core";

// ---------------------------------------------------------------------------
// Singleton engine. Holds all managed tunnel processes in-process and drives
// them via systemd (VPS) or child processes (dev/WSL).
// ---------------------------------------------------------------------------

function resolveDataDir(): string {
  if (process.env.XT_DATA_DIR) return process.env.XT_DATA_DIR;
  return path.resolve(process.cwd(), "..", "..", "tunnels");
}

function resolveForwarderScript(): string {
  if (process.env.XT_FORWARDER_SCRIPT) return process.env.XT_FORWARDER_SCRIPT;
  return path.resolve(
    process.cwd(),
    "..",
    "..",
    "packages",
    "tunnel-core",
    "src",
    "forwarder-runner.ts",
  );
}

const globalForEngine = globalThis as unknown as { xEngine?: TunnelEngine };

export function getEngine(): TunnelEngine {
  if (!globalForEngine.xEngine) {
    globalForEngine.xEngine = new TunnelEngine({
      dataDir: resolveDataDir(),
      envFile: process.env.XT_ENV_FILE,
      forceNodeFallback: process.env.XT_FORCE_NODE === "true",
      forwarderRunner: {
        prefix: ["node", "--experimental-strip-types"],
        script: resolveForwarderScript(),
      },
    });
  }
  return globalForEngine.xEngine;
}
