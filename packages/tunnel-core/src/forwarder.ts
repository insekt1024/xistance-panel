import net from "node:net";
import dgram from "node:dgram";
import type { PortForwardRule } from "@xistance/types";

// ---------------------------------------------------------------------------
// Userland TCP/UDP port forwarder daemon.
//
// Each rule opens a listener on <sourcePort> and forwards to <destHost:destPort>.
// TCP uses Node's net.Server; UDP tracks client -> upstream mappings with a TTL
// garbage collector. Runs in-process (panel dev) or as a standalone worker
// (production systemd unit). Requires root to bind ports < 1024.
// ---------------------------------------------------------------------------

export interface ForwarderStats {
  sessions: number;
  bytesForwarded: bigint;
}

export interface ForwardHandle {
  id: string;
  protocol: "tcp" | "udp";
  sourcePort: number;
  stop(): Promise<void>;
}

const SESSION_TTL_MS = 15_000;
// Idle TCP relay pairs are destroyed after this long without any bytes in
// either direction (mirrors the UDP flow TTL idea for long-lived sockets).
const TCP_IDLE_TIMEOUT_MS = 10 * 60_000;
const TCP_IDLE_CHECK_MS = 60_000;

interface UdpFlow {
  upstream: dgram.Socket;
  lastSeen: number;
}

function bindHost(conn: { sourcePort: number }): number {
  return conn.sourcePort;
}

export function startForwarder(rule: PortForwardRule): Promise<ForwardHandle> {
  if (rule.protocol === "tcp") return startTcp(rule);
  return startUdp(rule);
}

// --- TCP ------------------------------------------------------------------//

function startTcp(rule: PortForwardRule): Promise<ForwardHandle> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect({
        host: rule.destHost,
        port: rule.destPort,
      });
      let lastActivity = Date.now();
      const touch = () => {
        lastActivity = Date.now();
      };
      client.on("data", touch);
      upstream.on("data", touch);
      const idleTimer = setInterval(() => {
        if (Date.now() - lastActivity > TCP_IDLE_TIMEOUT_MS) {
          clearInterval(idleTimer);
          client.destroy();
          upstream.destroy();
        }
      }, TCP_IDLE_CHECK_MS);
      idleTimer.unref();
      const clearIdle = () => clearInterval(idleTimer);
      client.on("close", clearIdle);
      upstream.on("close", clearIdle);
      client.pipe(upstream).pipe(client);
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    server.on("error", reject);
    server.listen(bindHost(rule), "0.0.0.0", () => {
      resolve({
        id: rule.id ?? `${rule.name}`,
        protocol: "tcp",
        sourcePort: rule.sourcePort,
        stop: () =>
          new Promise<void>((res) => server.close(() => res())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
function startUdp(rule: PortForwardRule): Promise<ForwardHandle> {
  return new Promise((resolve, reject) => {
    const listener = dgram.createSocket("udp4");
    const flows = new Map<string, UdpFlow>();
    const cleanup = setInterval(() => {
      const now = Date.now();
      for (const [key, f] of flows) {
        if (now - f.lastSeen > SESSION_TTL_MS) {
          flows.delete(key);
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
      let flow = flows.get(key);
      if (!flow) {
        const upstream = dgram.createSocket("udp4");
        upstream.on("message", (res) => {
          listener.send(res, rinfo.port, rinfo.address);
        });
        upstream.on("error", () => {});
        upstream.send(msg, rule.destPort, rule.destHost);
        flow = { upstream, lastSeen: Date.now() };
        flows.set(key, flow);
      } else {
        flow.lastSeen = Date.now();
        flow.upstream.send(msg, rule.destPort, rule.destHost);
      }
    });

    listener.bind(bindHost(rule), "0.0.0.0", () => {
      resolve({
        id: rule.id ?? rule.name,
        protocol: "udp",
        sourcePort: rule.sourcePort,
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
          await new Promise<void>((r) => listener.close(() => r()));
        },
      });
    });
  });
}

export async function startForwarders(rules: PortForwardRule[]): Promise<ForwardHandle[]> {
  const handles: ForwardHandle[] = [];
  try {
    for (const rule of rules) {
      if (!rule.enabled) continue;
      handles.push(await startForwarder(rule));
    }
  } catch (err) {
    // Roll back already-bound listeners (same pattern as forwarder-runner.ts
    // main()): without this a mid-batch bind failure leaves half the ports
    // bound with no handle to stop them.
    await Promise.all(handles.map((h) => h.stop()));
    throw err;
  }
  return handles;
}

export async function stopForwarders(handles: ForwardHandle[]): Promise<void> {
  await Promise.all(handles.map((h) => h.stop()));
}