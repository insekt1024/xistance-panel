import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Runner } from "./runner.js";

// ---------------------------------------------------------------------------
// Binary registry: ensures the VPS has the tunnel binaries it needs. install.sh
// performs the real downloads; this layer verifies presence + (optionally) a
// checksum so the panel fails loudly with a helpful message instead of running
// a missing binary.
// ---------------------------------------------------------------------------

export interface BinaryDef {
  /** relative path under the tunnel binary directory */
  path: string;
  /** expected sha256 (hex) if known; otherwise undefined => trust presence */
  sha256?: string;
  /** human-readable install hint */
  hint: string;
}

export class BinaryManager {
  constructor(
    private readonly binDir: string,
    private readonly runner: Runner,
  ) {}

  absolutePath(name: string): string {
    // self path resolution for remote runners happens at deploy time via
    // engine.getBinaryPathOn(target)
    return path.join(this.binDir, name);
  }

  async ensure(binaries: BinaryDef[]): Promise<Record<string, string>> {
    const resolved: Record<string, string> = {};
    for (const b of binaries) {
      const abs = this.binDir;
      const local = path.join(abs, b.path);
      const fileAt = path.join(local);
      const present = await this.runner.exists(fileAt);
      if (!present) {
        throw new Error(
          `Required binary "${b.path}" is missing at ${fileAt}. ${b.hint}`,
        );
      }
      if (b.sha256) {
        const actual = await this.sha256(fileAt);
        if (actual !== b.sha256) {
          throw new Error(
            `Binary "${b.path}" failed checksum validation (expected ${b.sha256}, got ${actual}).`,
          );
        }
      }
      resolved[b.path] = fileAt;
    }
    return resolved;
  }

  private async sha256(file: string): Promise<string> {
    const buf = await fs.readFile(file);
    return createHash("sha256").update(buf).digest("hex");
  }

  binDirPath(): string {
    return this.binDir;
  }
}

// ---------------------------------------------------------------------------
// Static registry of the known binaries per tunnel method. URL/downloading is
// delegated to scripts/install.sh (works better under restricted networks and
// with mirrors); the panel requires the binary to already be present.
// ---------------------------------------------------------------------------

export interface EngineBinary {
  tool: string;
  /** names of binaries required based on role */
  client?: string;
  server?: string;
  hint: string;
}

export const ENGINE_BINARIES: Record<string, EngineBinary> = {
  BACKHAUL: {
    tool: "backhaul",
    client: "backhaul",
    server: "backhaul",
    hint:
      'Run: xistance install --bin backhaul  (or scripts/install.sh) to fetch the Backhaul binary.',
  },
  FRP: {
    tool: "frp",
    client: "frpc",
    server: "frps",
    hint:
      'Run: xistance install --bin frp  (or scripts/install.sh) to fetch frpc/frps binaries.',
  },
  GOST: {
    tool: "gost",
    client: "gost",
    server: "gost",
    hint: 'Run: xistance install --bin gost  (or scripts/install.sh).',
  },
};