// Self-contained port-forward worker. This file MUST stay dependency-free apart
// from Node builtins so it can run anywhere via:
//
//   node --experimental-strip-types forwarder-runner.ts --rules /path/rules.json
//
// rules.json: array of { name, direction, protocol, sourcePort, destHost,
// destPort, enabled }. Prints XT_FORWARDER_READY once all listeners are bound.

import { readFile } from "node:fs/promises";
import net from "node:net";
import dgram from "node:dgram";

interface Rule {
  name: string;
  protocol: "tcp" | "udp";
  sourcePort: number;
  destHost: string;
  destPort: number;
  enabled: boolean;
}

interface ForwardHandle {
  stop(): Promise<void>;
}

function isRule(v: unknown): v is Rule {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    (r.protocol === "tcp" || r.protocol === "udp") &&
    typeof r.sourcePort === "number" &&
    typeof r.destHost === "string" &&
    typeof r.destPort === "number"
  );
}

function startTcp(r: Rule): Promise<ForwardHandle> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect({ host: r.destHost, port: r.destPort });
      client.pipe(upstream).pipe(client);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    server.on("error", reject);
    server.listen(r.sourcePort, "0.0.0.0", () => {
      resolve({ stop: () => new Promise<void>((res) => server.close(() => res())) });
    });
  });
}

const FLOW_TTL_MS = 15_000;

function startUdp(r: Rule): Promise<ForwardHandle> {
  return new Promise((resolve, reject) => {
    const listener = dgram.createSocket("udp4");
    const flows = new Map<string, { upstream: dgram.Socket; lastSeen: number }>();
    const cleanup = setInterval(() => {
      const now = Date.now();
      for (const [k, f] of flows) {
        if (now - f.lastSeen > FLOW_TTL_MS) {
          flows.delete(k);
          try {
            f.upstream.close();
          } catch {
            /* ignore */
          }
        }
      }
    }, 10_000);
    cleanup.unref();

    listener.on("error", (err) => {
      clearInterval(cleanup);
      reject(err);
    });
    listener.on("message", (msg, rinfo) => {
      const key = `${rinfo.address}:${rinfo.port}`;
      const existing = flows.get(key);
      if (existing) {
        existing.lastSeen = Date.now();
        existing.upstream.send(msg, r.destPort, r.destHost);
        return;
      }
      const upstream = dgram.createSocket("udp4");
      upstream.on("message", (res) => listener.send(res, rinfo.port, rinfo.address));
      upstream.on("error", () => {});
      upstream.send(msg, r.destPort, r.destHost);
      flows.set(key, { upstream, lastSeen: Date.now() });
    });

    listener.bind(r.sourcePort, "0.0.0.0", () => {
      resolve({
        stop: async () => {
          clearInterval(cleanup);
          for (const f of flows.values()) {
            try {
              f.upstream.close();
            } catch {
              /* ignore */
            }
          }
          flows.clear();
          await new Promise<void>((res) => listener.close(() => res()));
        },
      });
    });
  });
}

async function main(): Promise<void> {
  const idx = process.argv.indexOf("--rules");
  if (idx === -1) throw new Error("--rules <file> is required");
  const raw = JSON.parse(await readFile(process.argv[idx + 1], "utf8"));
  if (!Array.isArray(raw)) throw new Error("rules must be an array");
  const rules: Rule[] = raw.filter(isRule);

  const handles: ForwardHandle[] = [];
  try {
    for (const rule of rules) {
      if (!rule.enabled) continue;
      const h = rule.protocol === "tcp" ? await startTcp(rule) : await startUdp(rule);
      handles.push(h);
      process.stdout.write(`XT_FORWARDER_UP ${rule.sourcePort}/${rule.protocol}\n`);
    }
    process.stdout.write("XT_FORWARDER_READY\n");
  } catch (err) {
    await Promise.all(handles.map((h) => h.stop()));
    process.stderr.write(`XT_FORWARDER_ERROR ${(err as Error).message}\n`);
    process.exit(1);
  }

  const SHUTDOWN_TIMEOUT_MS = 10_000;
  const shutdown = (sig: string) => {
    process.stdout.write(`XT_FORWARDER_SHUTDOWN ${sig}\n`);
    const forceExit = setTimeout(() => {
      process.stderr.write("XT_FORWARDER_SHUTDOWN_TIMEOUT force-exiting\n");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();
    void Promise.all(handles.map((h) => h.stop())).finally(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  process.stderr.write(`XT_FORWARDER_FATAL ${(err as Error).message}\n`);
  process.exit(1);
});
