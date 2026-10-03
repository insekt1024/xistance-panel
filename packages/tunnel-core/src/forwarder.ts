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
    // Every accepted socket is tracked. `server.close()` alone stops new
    // accepts but never completes while an established connection is still
    // open, so the stop() promise would hang for the lifetime of the client --
    // measured: the close callback had not fired after 1.5s with one idle
    // client connected. Destroying the tracked sockets is what actually makes
    // the close callback run.
    const sockets = new Set<net.Socket>();
    let stopped = false;

    const server = net.createServer((client) => {
      sockets.add(client);
      client.once("close", () => sockets.delete(client));
      client.once("error", () => sockets.delete(client));
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
          new Promise<void>((res, rej) => {
            // Idempotent: a second stop must resolve, not reject.
            if (stopped) {
              res();
              return;
            }
            stopped = true;
            for (const s of sockets) {
              try {
                s.destroy();
              } catch {
                /* already gone */
              }
            }
            sockets.clear();
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
/**
 * Create a per-client UDP upstream socket bound to a usable local port.
 *
 * Calling `socket.send()` without a prior `bind()` lets the OS choose the local
 * port, and on Windows that choice can land inside a reserved/excluded range
 * (Hyper-V and WSL reserve large dynamic blocks, e.g. 50798-50897), which fails
 * with EACCES. The per-flow error handler is intentionally a no-op, so that
 * failure was swallowed: the flow was recorded as established and every packet
 * for that client vanished while the tunnel still reported itself healthy.
 * Bind explicitly and retry with a fresh port so one unlucky choice is not fatal.
 */
function createBoundUpstream(attempts = 8): Promise<dgram.Socket> {
  return new Promise((resolve, reject) => {
    let lastError: unknown;
    const tryOnce = (remaining: number): void => {
      const socket = dgram.createSocket("udp4");
      const onError = (err: unknown): void => {
        lastError = err;
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        if (remaining <= 0) {
          reject(
            new Error(
              `could not bind a UDP upstream socket after ${attempts} attempts: ${
                lastError instanceof Error ? lastError.message : String(lastError)
              }`,
            ),
          );
          return;
        }
        tryOnce(remaining - 1);
      };
      socket.once("error", onError);
      // Port 0 asks the OS for a free port, but "free" can still mean
      // excluded-from-bind on Windows, so this is retried rather than trusted.
      socket.bind(0, "0.0.0.0", () => {
        socket.removeListener("error", onError);
        resolve(socket);
      });
    };
    tryOnce(attempts - 1);
  });
}

// ---------------------------------------------------------------------------
function startUdp(rule: PortForwardRule): Promise<ForwardHandle> {
  return new Promise((resolve, reject) => {
    const listener = dgram.createSocket("udp4");
    const flows = new Map<string, UdpFlow>();
    let stopped = false;
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
      const flow = flows.get(key);
      if (!flow) {
        // Bind before the first send: an unbound send() lets the OS pick the
        // local port, which on Windows can be an excluded range (EACCES), and
        // the no-op error handler below would swallow it -- the flow would be
        // recorded as established and silently drop every packet.
        void createBoundUpstream()
          .then((upstream) => {
            upstream.on("message", (res) => {
              listener.send(res, rinfo.port, rinfo.address);
            });
            upstream.on("error", () => {});
            upstream.send(msg, rule.destPort, rule.destHost);
            flows.set(key, { upstream, lastSeen: Date.now() });
          })
          .catch(() => {
            // Could not obtain a usable upstream socket for this client. Drop
            // the packet rather than record a flow that cannot send.
          });
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
          if (stopped) return;
          stopped = true;
          clearInterval(cleanup);
          for (const f of flows.values()) {
            try {
              f.upstream.close();
            } catch {
              /* ignore */
            }
          }
          flows.clear();
          // A socket that is already closed makes close() emit ERR_SOCKET_DGRAM_NOT_RUNNING;
          // that is a successful stop, not a failure, so it must not reject.
          try {
            await new Promise<void>((r) => listener.close(() => r()));
          } catch {
            /* already closed */
          }
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
  // AllSettled, not all: one handle that fails to close must not prevent the
  // others from being stopped, leaving their ports bound.
  const results = await Promise.allSettled(handles.map((h) => h.stop()));
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failed.length > 0) {
    // Aggregate without leaking rule internals into the message.
    throw new Error(`${failed.length} of ${handles.length} forwarder(s) failed to stop`);
  }
}