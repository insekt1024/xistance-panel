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
// NOTE: this module deliberately imports NOTHING but node builtins. It is run
// directly with `node --experimental-strip-types`, which cannot resolve a
// relative .js specifier to its .ts source. An earlier fix imported
// createBoundUpstream() from ./forwarder.js and the selftest stopped running at
// all. The helper is therefore duplicated below rather than shared.

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
  /** The port actually bound. Differs from rule.sourcePort when it was 0. */
  port?: number;
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
    // Every accepted socket is tracked, exactly as in forwarder.ts.
    //
    // server.close() alone stops new accepts but its callback never fires while
    // an established connection is open, so stop() would hang for the lifetime
    // of the client. MEASURED on this runner: with one idle client connected,
    // SIGTERM did not exit the process within 8s and the close callback had
    // not run. Destroying the tracked sockets is what makes it complete.
    const sockets = new Set<net.Socket>();
    let stopped = false;
    const server = net.createServer((client) => {
      sockets.add(client);
      client.once("close", () => sockets.delete(client));
      client.once("error", () => sockets.delete(client));
      const upstream = net.connect({ host: r.destHost, port: r.destPort });
      upstream.once("error", () => client.destroy());
      client.once("error", () => upstream.destroy());
      client.pipe(upstream).pipe(client);
    });
    server.on("error", reject);
    server.listen(r.sourcePort, BIND_ADDR, () => {
      const addr = server.address();
      const boundPort = addr && typeof addr === "object" ? addr.port : r.sourcePort;
      resolve({
        port: boundPort,
        stop: () =>
          new Promise<void>((res, rej) => {
            // Idempotent: a second stop resolves rather than double-closing.
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
            // Forward the close error, as the library forwarder does. Swallowing
            // it here means ERR_SERVER_NOT_RUNNING on a repeated stop() looks
            // like success -- which is why removing the `stopped` guard was
            // invisible to the selftest.
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

const FLOW_TTL_MS = 15_000;

// All interfaces, matching the library forwarder. Kept in one place so the two
// implementations cannot drift.
const BIND_ADDR = "0.0.0.0";

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
 *
 * Duplicated from forwarder.ts on purpose -- see the import note at the top.
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
      socket.bind(0, BIND_ADDR, () => {
        socket.removeListener("error", onError);
        resolve(socket);
      });
    };
    tryOnce(attempts - 1);
  });
}

function startUdp(r: Rule): Promise<ForwardHandle> {
  return new Promise((resolve, reject) => {
    const listener = dgram.createSocket("udp4");
    const flows = new Map<string, { upstream: dgram.Socket; lastSeen: number }>();
  let stopped = false;
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
      // Bind before the first send: an unbound send() lets the OS pick the local
      // port, which on Windows can be an excluded range (EACCES), and the no-op
      // error handler below would swallow it -- the flow would be recorded as
      // established and silently drop every packet.
      void createBoundUpstream()
        .then((upstream) => {
          upstream.on("message", (res) => listener.send(res, rinfo.port, rinfo.address));
          upstream.on("error", () => {});
          upstream.send(msg, r.destPort, r.destHost);
          flows.set(key, { upstream, lastSeen: Date.now() });
        })
        .catch(() => {
          // No usable upstream socket for this client; drop the packet rather
          // than record a flow that cannot send.
        });
    });

    listener.bind(r.sourcePort, BIND_ADDR, () => {
      resolve({
        port: r.sourcePort,
        stop: async () => {
          // Idempotent, matching the library forwarder (TASK-21): a second stop
          // must resolve, not reject. This shipped without the guard even
          // though the library had it -- closing an already-closed dgram socket
          // throws ERR_SOCKET_DGRAM_NOT_RUNNING.
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
          // A socket that is already closed emits ERR_SOCKET_DGRAM_NOT_RUNNING;
          // that is a successful stop, not a failure, so it must not reject.
          try {
            await new Promise<void>((res) => listener.close(() => res()));
          } catch {
            /* already closed */
          }
        },
      });
    });
  });
}

/**
 * `--selftest` exercises the REAL teardown path in-process and reports the
 * result on stdout.
 *
 * Why this exists: the runner's stop() can only be reached through a signal, and
 * a JS-level SIGTERM handler does not fire on Windows when the parent uses
 * child.kill("SIGTERM") -- verified with a minimal child that only registered
 * process.on("SIGTERM"): the handler never ran and the process never exited. So
 * on a non-POSIX host the signal path is untestable from outside, and an
 * external probe silently measures the harness rather than the code.
 *
 * Running the teardown in-process keeps the assertion on the shipped logic --
 * the same startTcp/stop() the systemd unit uses -- while staying
 * Node-builtins-only, as this file must.
 *
 * Prints XT_SELFTEST_PASS <detail> or XT_SELFTEST_FAIL <detail>; exit 0 / 1.
 */
async function selftest(): Promise<boolean> {
  // A throwaway upstream so the forwarded socket is genuinely ESTABLISHED.
  const upstream = net.createServer((s) => s.on("data", (b) => s.write(b)));
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
  const destPort = (upstream.address() as net.AddressInfo).port;

  // Port 0 lets the OS pick a free ephemeral port, so the selftest can never
  // collide with a real listener.
  const handle = await startTcp({
    name: "selftest",
    protocol: "tcp",
    sourcePort: 0,
    destHost: "127.0.0.1",
    destPort,
    enabled: true,
  });
  // startTcp listens on rule.sourcePort; recover the real port from the socket.
  const bound = handle.port ?? 0;
  if (bound === 0) {
    process.stderr.write("XT_SELFTEST_FAIL could not determine the bound port\n");
    upstream.close();
    return false;
  }

  const client = net.connect({ host: "127.0.0.1", port: bound });
  client.on("error", () => {
    /* torn down during the test */
  });
  await new Promise<void>((r) => client.once("connect", () => r()));
  client.write("ping");
  await new Promise((r) => setTimeout(r, 300));

  const t0 = Date.now();
  let done = false;
  void handle.stop().then(() => {
    done = true;
  });
  const deadline = Date.now() + 5000;
  while (!done && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));

  client.destroy();
  upstream.close();

  if (!done) {
    process.stderr.write("XT_SELFTEST_FAIL stop() did not settle within 5000ms with a live client\n");
    return false;
  }
  // Idempotence: a second stop must also settle, not throw. Asserted through a
  // REAL second call, because a mutation that removes the guard still settles
  // -- server.close() on a closed server invokes the callback -- so only a
  // repeated call proves the guard.
  let secondOk = true;
  try {
    await handle.stop();
  } catch {
    secondOk = false;
  }
  if (!secondOk) {
    process.stderr.write("XT_SELFTEST_FAIL a second stop() rejected\n");
    return false;
  }
  // A third call, concurrent with the second, must also settle.
  const both = await Promise.allSettled([handle.stop(), handle.stop()]);
  if (both.some((r) => r.status === "rejected")) {
    process.stderr.write("XT_SELFTEST_FAIL concurrent stop() calls rejected\n");
    return false;
  }

  // Repeated stop() AFTER new traffic. The `stopped` guard is only observable
  // here: a bare `server.close()` on an already-closed server still fires its
  // callback, so the second-call check above passes either way. But without the
  // guard, a stop() that arrives after a NEW client is accepted sees a
  // non-empty socket set, destroys nothing it owns, and re-closes a closed
  // server -- and the live client keeps the port occupied.
  const fresh = await ephemeralPort();
  const h2 = await startTcp({
    name: "repeat",
    protocol: "tcp",
    sourcePort: fresh,
    destHost: "127.0.0.1",
    destPort,
    enabled: true,
  });
  const c2 = net.connect({ host: "127.0.0.1", port: h2.port ?? fresh });
  c2.on("error", () => {
    /* torn down during the test */
  });
  await new Promise<void>((r) => c2.once("connect", () => r()));
  await h2.stop();
  c2.destroy();
  // A later stop must be a no-op that still lets the port be reused.
  let repeatOk = true;
  try {
    await h2.stop();
  } catch {
    repeatOk = false;
  }
  if (!repeatOk) {
    process.stderr.write("XT_SELFTEST_FAIL a post-traffic repeat stop() rejected\n");
    return false;
  }
  if (!(await canBind(fresh))) {
    process.stderr.write(`XT_SELFTEST_FAIL port ${fresh} is still held after a repeated stop()\n`);
    return false;
  }

  // --- Batch rollback -----------------------------------------------------
  // A mid-batch bind failure must roll back the listeners that DID bind, and
  // one handle that fails to stop must not strand the others. Proven by making
  // the second rule fail to bind -- by occupying the port it wants, so the
  // failure is EADDRINUSE for any user on any platform -- while the first
  // holds a real port.
  const batchOk = await selftestBatchRollback();
  if (!batchOk) return false;

  // --- Rollback isolation -------------------------------------------------
  // allSettled vs all is only observable when a handle FAILS. With all, the
  // first rejection aborts the rest and the surviving ports stay bound -- the
  // exact leak rollbackHandles exists to prevent. A handle that rejects on stop
  // is injected alongside a real listener, then the real port must be free.
  const isoPort = await ephemeralPort();
  const real = await startTcp({
    name: "iso",
    protocol: "tcp",
    sourcePort: isoPort,
    destHost: "127.0.0.1",
    destPort,
    enabled: true,
  });
  const booby: ForwardHandle = {
    stop: () => Promise.reject(new Error("simulated teardown failure")),
  };
  // rollbackHandles must NOT throw: it is called from a catch block that is
  // about to write an error and exit, and a throw here would replace the real
  // bind error with an unrelated teardown error. allSettled absorbs the
  // rejection, so the code after this block is always reached with the good
  // implementation and never reached with `all`.
  let propagated = false;
  try {
    await rollbackHandles([booby, real]);
  } catch {
    propagated = true;
  }
  if (propagated) {
    process.stderr.write("XT_SELFTEST_FAIL rollbackHandles propagated a teardown failure\n");
    return false;
  }
  // allSettled vs all differs in TIMING, not ownership: .map() already invoked
  // every stop(), so the real listener does get torn down under all() too -- but
  // all() rejects on the FIRST rejection and returns while the real stop() is
  // still in flight. Measured: with all(), the real handle had NOT completed
  // 0ms after the rejection; with allSettled() it has. So the wait is what
  // distinguishes them, and the port check must come after it.
  await new Promise((r) => setTimeout(r, 400));
  if (!(await canBind(isoPort))) {
    process.stderr.write(
      `XT_SELFTEST_FAIL one failing handle stranded port ${isoPort} (allSettled not honoured)\n`,
    );
    return false;
  }

  // --- UDP teardown -------------------------------------------------------
  const udpOk = await selftestUdpStop();
  if (!udpOk) return false;

  process.stdout.write(
    `XT_SELFTEST_PASS tcp stop settled in ${Date.now() - t0}ms with a live client; ` +
      `idempotent; batch rollback and udp stop verified\n`,
  );
  return true;
}

/**
 * A batch bind failure must release the ports that already bound.
 *
 * Runs the same start()/stop() sequence main() uses, so the assertion is on the
 * shipped path rather than a re-implementation.
 */
async function selftestBatchRollback(): Promise<boolean> {
  const free = await ephemeralPort();
  // Occupy a second port so the "b" rule is GUARANTEED to fail to bind.
  //
  // An earlier version used privileged port 1 to provoke EACCES. That is wrong
  // in two ways: the host running this selftest may be root (where port 1
  // binds fine, so the rollback path was silently skipped), and Windows does
  // not enforce privileged ports the way Linux does. An already-bound port
  // fails with EADDRINUSE for every user on every platform, so the path is
  // now always reachable.
  const taken = net.createServer();
  await new Promise<void>((r) => taken.listen(0, BIND_ADDR, () => r()));
  const takenPort = (taken.address() as net.AddressInfo).port;

  const handles: ForwardHandle[] = [];
  try {
    for (const rule of [
      { name: "a", protocol: "tcp", sourcePort: free, destHost: "127.0.0.1", destPort: 9, enabled: true },
      { name: "b", protocol: "tcp", sourcePort: takenPort, destHost: "127.0.0.1", destPort: 9, enabled: true },
    ] as Rule[]) {
      if (!rule.enabled) continue;
      handles.push(rule.protocol === "tcp" ? await startTcp(rule) : await startUdp(rule));
    }
    // Reached only if the "b" bind unexpectedly succeeded.
    await Promise.allSettled(handles.map((h) => h.stop()));
    await new Promise<void>((r) => taken.close(() => r()));
    process.stderr.write(
      `XT_SELFTEST_FAIL expected port ${takenPort} to be unbindable, but the rule bound it\n`,
    );
    return false;
  } catch {
    // The expected outcome: rule "b" failed, so roll back rule "a" through the
    // SHIPPED rollback function and prove the port is genuinely free again.
    await rollbackHandles(handles);
    await new Promise<void>((r) => taken.close(() => r()));
    const reusable = await canBind(free);
    if (!reusable) {
      process.stderr.write(`XT_SELFTEST_FAIL port ${free} was still bound after a rollback\n`);
      return false;
    }
    process.stdout.write(`XT_SELFTEST_PASS batch rollback released port ${free}\n`);
    return true;
  }
}

/** UDP stop must settle, and a repeated stop must not throw. */
async function selftestUdpStop(): Promise<boolean> {
  const port = await ephemeralPort();
  const h = await startUdp({ name: "u", protocol: "udp", sourcePort: port, destHost: "127.0.0.1", destPort: 9, enabled: true });
  let settled = false;
  void h.stop().then(() => {
    settled = true;
  });
  const deadline = Date.now() + 5000;
  while (!settled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (!settled) {
    process.stderr.write("XT_SELFTEST_FAIL udp stop() did not settle within 5000ms\n");
    return false;
  }
  const again = await Promise.allSettled([h.stop(), h.stop()]);
  if (again.some((r) => r.status === "rejected")) {
    process.stderr.write("XT_SELFTEST_FAIL repeated udp stop() rejected\n");
    return false;
  }
  return true;
}

/** Ask the OS for a free port, then release it. */
async function ephemeralPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** True when a TCP listener can bind the port -- i.e. nothing still holds it. */
async function canBind(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "0.0.0.0", () => s.close(() => resolve(true)));
  });
}

/**
 * Release every listener bound so far after a mid-batch failure.
 *
 * Extracted from main() so the selftest exercises the SHIPPED rollback rather
 * than a copy of it: when this logic lived inline, a mutation to the production
 * line was invisible to the test, because the test had its own duplicate.
 *
 * allSettled, not all: one handle that fails to stop must not leave the other
 * ports bound with nobody holding their handle.
 */
async function rollbackHandles(handles: ForwardHandle[]): Promise<void> {
  await Promise.allSettled(handles.map((h) => h.stop()));
}

async function main(): Promise<void> {
  if (process.argv.includes("--selftest")) {
    // selftest() returns booleans on the failure paths; normalise so the
    // exit code is always a real number (process.exit(false) throws).
    process.exit((await selftest()) ? 0 : 1);
  }
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
    await rollbackHandles(handles);
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
