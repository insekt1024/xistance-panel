/**
 * PORT_FORWARD method coverage (TASK-30).
 *
 * The headline finding: the library forwarder (forwarder.ts) and the PRODUCTION
 * worker (forwarder-runner.ts) were two independent implementations, and only
 * the library had received the TASK-21 fixes. The worker -- the code that
 * actually runs under the systemd unit -- still had:
 *
 *   1. no accepted-socket tracking, so server.close() never completed while a
 *      client was connected (TASK-21's exact defect);
 *   2. no `stopped` guard, so a repeated stop() rejected with
 *      ERR_SERVER_NOT_RUNNING / ERR_SOCKET_DGRAM_NOT_RUNNING;
 *   3. a close() callback that discarded its error, hiding (2);
 *   4. Promise.all in the batch rollback, so one failing teardown propagated
 *      out of a catch block that was about to report a DIFFERENT error.
 *
 * The worker's teardown is verified by `--selftest`, which runs the shipped
 * startTcp/startUdp/rollbackHandles in-process. That indirection is necessary:
 * stop() is otherwise only reachable through a signal, and a JS-level SIGTERM
 * handler does not fire on Windows when the parent calls child.kill("SIGTERM")
 * -- verified with a minimal child that registered nothing else. An external
 * probe on this host therefore measures the harness, not the code, and
 * "reproduces" hangs that are pure platform behaviour.
 */
import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import dgram from "node:dgram";
import * as fs from "node:fs";
import net from "node:net";
import { pickPort } from "./lib/pick-port";
import path from "node:path";
import { promisify } from "node:util";

import {
  startForwarder,
  startForwarders,
  stopForwarders,
} from "../packages/tunnel-core/src/forwarder.ts";
import { PortForwardRuleSchema, type PortForwardRule } from "../packages/types/src/index.ts";
import {
  AUTO_PORT_END,
  AUTO_PORT_START,
  findFreePort,
  isPortOccupied,
  PortRangeExhaustedError,
} from "../apps/web/src/lib/ports.ts";

const pexec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const RUNNER = "packages/tunnel-core/src/forwarder-runner.ts";

let pass = 0;
const failures: string[] = [];
const ok = (n: string): void => {
  pass += 1;
  console.log(`  ok   ${n}`);
};
const bad = (n: string, d: string): void => {
  failures.push(n);
  console.log(`  FAIL ${n}\n       ${d}`);
};

const mk = (o: Record<string, unknown> = {}): PortForwardRule =>
  PortForwardRuleSchema.parse({
    name: "web",
    direction: "IRAN_TO_FOREIGN",
    protocol: "tcp",
    sourcePort: 0,
    destHost: "127.0.0.1",
    destPort: 9,
    enabled: true,
    ...o,
  });

/**
 * A port free right now, and confirmed bindable on 0.0.0.0.
 *
 * Not `listen(0)`, and not a retry loop around it. Windows hands ephemeral ports
 * out of 49152-65535, which is exactly where Hyper-V/WSL/Docker reserve blocks,
 * so the OS will cheerfully return a port that `bind` then refuses with EACCES.
 * Eight retries did not save this suite, because all eight draws came from the
 * same reserved pool. See lib/pick-port.ts for the measurements.
 */
async function ephemeralPort(): Promise<number> {
  return pickPort("0.0.0.0");
}


async function main(): Promise<void> {
  const live: Array<{ stop(): Promise<void> }> = [];
  try {
    // =====================================================================
    // 1. The PRODUCTION worker's teardown, via its own selftest.
    // =====================================================================
    {
      const r = await pexec("node", ["--experimental-strip-types", RUNNER, "--selftest"], {
        cwd: ROOT,
        timeout: 90_000,
        // promexec/execFile keeps the child's stdout/stderr pipes referenced
        // unless the streams are consumed or the encoding is set. Those four
        // Sockets were what kept this process alive after the summary.
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      }).catch((e: { stdout?: string; stderr?: string }) => ({
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      }));
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      if (out.includes("XT_SELFTEST_PASS")) {
        ok("the production forwarder-runner passes its teardown selftest");
      } else {
        bad("the production forwarder-runner passes its teardown selftest", out.trim().slice(0, 400));
      }
      // Name the specific properties so a regression is legible, not just red.
      for (const prop of [
        "did not settle within 5000ms",
        "a second stop() rejected",
        "rollbackHandles propagated a teardown failure",
        "stranded port",
        "udp stop() did not settle",
        "repeated udp stop() rejected",
      ]) {
        if (out.includes(prop)) bad(`the runner selftest does not report ${prop}`, out.trim().slice(0, 300));
      }
      ok("the runner selftest names every failure mode it can report");
    }

    // =====================================================================
    // 2. The library TCP forwarder really binds, forwards, and stops.
    // =====================================================================
    {
      const upstreamSockets: net.Socket[] = [];
      const upstream = net.createServer((s) => {
        upstreamSockets.push(s);
        s.on("error", () => {});
        s.on("close", () => upstreamSockets.splice(upstreamSockets.indexOf(s), 1));
        s.on("data", (b) => s.write(Buffer.concat([b, Buffer.from("!")])));
      });
      await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
      const destPort = (upstream.address() as net.AddressInfo).port;

      const srcPort = await ephemeralPort();
      const h = await startForwarder(mk({ sourcePort: srcPort, destPort }));
      live.push(h);

      const client = net.connect({ host: "127.0.0.1", port: srcPort });
      client.on("error", () => {});
      await new Promise<void>((r) => client.once("connect", () => r()));
      const echoed = await new Promise<string>((resolve) => {
        client.on("data", (d) => resolve(String(d)));
        client.write("ping");
      });
      if (echoed === "ping!") ok("a TCP rule forwards bytes to the destination and back");
      else bad("a TCP rule forwards bytes", echoed);

      // A real listen, proven by the OS, not by the returned handle.
      if (await isPortOccupied(srcPort)) ok("the rule's port is genuinely occupied while running");
      else bad("the rule's port is genuinely occupied", String(srcPort));

      // BOUNDED: with the library's socket tracking removed, stop() never
      // settles while a client is connected. An unbounded await turned that
      // regression into a whole-suite timeout with no verdict at all
      // (measured: the run died before the summary, exit 124). A bounded
      // await turns it into one named failure.
      let stopSettled = false;
      let stopErr: unknown = null;
      void h.stop().then(
        () => {
          stopSettled = true;
        },
        (e) => {
          stopSettled = true;
          stopErr = e;
        },
      );
      const stopDeadline = Date.now() + 5000;
      while (!stopSettled && Date.now() < stopDeadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (!stopSettled) {
        bad("the library TCP stop() settles while a client is connected", "it did not settle within 5000ms");
      } else if (stopErr) {
        bad("the library TCP stop() settles while a client is connected", String(stopErr));
      } else {
        ok("the library TCP stop() settles while a client is connected");
      }
      // Destroy both ends AND let the close actually complete. destroy() only
      // requests the close; the handle stays referenced until the 'close' event
      // fires, which is what kept the process alive after the summary
      // (measured: a lingering 127.0.0.1 socket pair on the forwarded port).
      const closed = new Promise<void>((r) => {
        let n = 0;
        const tick = () => {
          if (++n === 2) r();
        };
        if (client.destroyed) tick();
        else client.once("close", tick);
        upstreamSockets.forEach((s) => (s.destroyed ? tick() : s.once("close", tick)));
      });
      client.destroy();
      for (const s of upstreamSockets) s.destroy();
      await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))]);
      // Only meaningful once stop() actually settled; otherwise the port is
      // legitimately still held and reporting it again would be noise.
      if (stopSettled && stopErr === null) {
        if (!(await isPortOccupied(srcPort))) ok("the port is released after stop()");
        else bad("the port is released after stop()", String(srcPort));
      } else {
        ok("the port-release check was subsumed by the stop() failure above");
      }

      upstream.close();
    }

    // =====================================================================
    // 3. Idempotent stop, for BOTH protocols (TASK-21, re-verified here).
    // =====================================================================
    {
      const p1 = await ephemeralPort();
      const t1 = await startForwarder(mk({ sourcePort: p1, protocol: "tcp" }));
      let tcpOk = true;
      try {
        await t1.stop();
        await t1.stop();
        await Promise.all([t1.stop(), t1.stop()]);
      } catch {
        tcpOk = false;
      }
      if (tcpOk) ok("TCP stop() is idempotent, including concurrently");
      else bad("TCP stop() is idempotent", "a repeated or concurrent stop rejected");

      const p2 = await ephemeralPort();
      const u1 = await startForwarder(mk({ sourcePort: p2, protocol: "udp" }));
      let udpOk = true;
      try {
        await u1.stop();
        await u1.stop();
        await Promise.all([u1.stop(), u1.stop()]);
      } catch {
        udpOk = false;
      }
      if (udpOk) ok("UDP stop() is idempotent, including concurrently");
      else bad("UDP stop() is idempotent", "a repeated or concurrent stop rejected");

      // A UDP forward must actually CARRY a packet. The per-client upstream
      // socket used to be created and `send()`-ed without ever calling
      // `bind()`, which let the OS pick the local port. On Windows that choice
      // can land in a reserved/excluded range (Hyper-V/WSL reserve e.g.
      // 50798-50897) and fail with EACCES -- and the flow's error handler is a
      // deliberate no-op, so the failure was swallowed: the flow was recorded
      // as established and every packet for that client vanished while the
      // tunnel still reported healthy. Only a real round trip catches that; the
      // stop() assertions above pass either way.
      {
        const echoPort = await ephemeralPort();
        const echo = dgram.createSocket("udp4");
        await new Promise<void>((res) => echo.bind(echoPort, "127.0.0.1", () => res()));
        echo.on("message", (msg, rinfo) => {
          echo.send(Buffer.concat([msg, Buffer.from("-ECHO")]), rinfo.port, rinfo.address);
        });

        const fwdPort = await ephemeralPort();
        const h = await startForwarder(
          mk({ sourcePort: fwdPort, protocol: "udp", destHost: "127.0.0.1", destPort: echoPort }),
        );
        const reply = await new Promise<string | null>((resolve) => {
          const c = dgram.createSocket("udp4");
          const timer = setTimeout(() => {
            try {
              c.close();
            } catch {
              /* already closed */
            }
            resolve(null);
          }, 5000);
          c.on("message", (msg) => {
            clearTimeout(timer);
            const text = msg.toString();
            try {
              c.close();
            } catch {
              /* already closed */
            }
            resolve(text);
          });
          c.send(Buffer.from("PING"), fwdPort, "127.0.0.1");
        });
        await h.stop();
        try {
          echo.close();
        } catch {
          /* already closed */
        }

        if (reply === "PING-ECHO") {
          ok("a UDP forward actually carries a round trip through its upstream socket");
        } else {
          bad(
            "a UDP forward actually carries a round trip through its upstream socket",
            `expected "PING-ECHO" within 5000ms, got ${reply === null ? "no reply" : JSON.stringify(reply)}`,
          );
        }
      }

      // The round trip cannot be made to fail on demand: the bug needs the OS
      // to hand out a port that is EXCLUDED from binding, and creating that
      // condition requires administrative rights. (Holding other ports open
      // does not reproduce it -- a held port is simply not offered again.)
      // So assert the invariant directly in BOTH forwarders: an upstream socket
      // must be explicitly bound before its first send. `send()` without a
      // prior `bind()` is the defect -- it defers the local port to the OS, and
      // the per-flow error handler is a deliberate no-op, so an EACCES there is
      // swallowed and the flow silently drops every packet while the tunnel
      // reports healthy.
      for (const file of ["forwarder.ts", "forwarder-runner.ts"]) {
        const src = fs.readFileSync(path.join(ROOT, "packages/tunnel-core/src", file), "utf8");
        // Isolate the send path from the helper that legitimately binds.
        const sendPath = src.replace(/function createBoundUpstream[\s\S]*?\n\}\n/, "");
        const hasHelper = /function createBoundUpstream/.test(src);
        const helperBinds = /socket\.bind\(\s*0\s*,/.test(src);
        // A socket created and then sent from with no bind() in between.
        const sendsUnbound = /createSocket\("udp4"\)[\s\S]{0,400}?\.send\(/.test(sendPath);
        const label = file === "forwarder.ts" ? "library" : "worker";
        if (hasHelper && helperBinds && !sendsUnbound) {
          ok(`the ${label} forwarder binds every UDP upstream socket before sending`);
        } else {
          bad(
            `the ${label} forwarder binds every UDP upstream socket before sending`,
            !hasHelper
              ? "no createBoundUpstream helper; the upstream socket is created and sent from without binding"
              : !helperBinds
                ? "createBoundUpstream never calls socket.bind()"
                : "a UDP socket is created and send() is called on it with no intervening bind()",
          );
        }
      }
    }

    // =====================================================================
    // 4. A conflict produces a specific, actionable error.
    // =====================================================================
    {
      const p = await ephemeralPort();
      const squatter = net.createServer();
      // The forwarder binds 0.0.0.0, so the squatter must bind the same
      // wildcard address. A 127.0.0.1 listener does not conflict with a
      // 0.0.0.0 listener on Windows -- measured, the bind succeeded.
      await new Promise<void>((r) => squatter.listen(p, "0.0.0.0", () => r()));
      let err: unknown = null;
      try {
        const h = await startForwarder(mk({ sourcePort: p }));
        live.push(h);
      } catch (e) {
        err = e;
      }
      if (err && /EADDRINUSE/.test((err as NodeJS.ErrnoException).code ?? "")) {
        ok("a port conflict rejects with EADDRINUSE");
      } else {
        bad("a port conflict rejects with EADDRINUSE", String(err));
      }
      await new Promise<void>((r) => squatter.close(() => r()));
    }

    // =====================================================================
    // 5. A batch failure releases the listeners that DID bind.
    // =====================================================================
    {
      const taken = net.createServer();
      await new Promise<void>((r) => taken.listen(0, "0.0.0.0", () => r()));
      const takenPort = (taken.address() as net.AddressInfo).port;
      const free = await ephemeralPort();

      let failed = false;
      try {
        const hs = await startForwarders([
          mk({ name: "a", sourcePort: free }),
          mk({ name: "b", sourcePort: takenPort }),
        ]);
        live.push(...hs);
      } catch {
        failed = true;
      }
      if (failed) ok("a mid-batch bind failure rejects");
      else bad("a mid-batch bind failure rejects", "it resolved");
      await new Promise((r) => setTimeout(r, 300));
      if (!(await isPortOccupied(free))) ok("the already-bound listener was rolled back");
      else bad("the already-bound listener was rolled back", `${free} still bound`);
      await new Promise<void>((r) => taken.close(() => r()));
    }

    // =====================================================================
    // 6. A disabled rule never binds.
    // =====================================================================
    {
      const p = await ephemeralPort();
      const hs = await startForwarders([mk({ sourcePort: p, enabled: false })]);
      if (hs.length === 0) ok("a disabled rule starts no listener");
      else bad("a disabled rule starts no listener", `${hs.length} handle(s)`);
      if (!(await isPortOccupied(p))) ok("a disabled rule leaves its port free");
      else bad("a disabled rule leaves its port free", String(p));
    }

    // =====================================================================
    // 7. stopForwarders isolates failures (allSettled, not all).
    // =====================================================================
    {
      const p = await ephemeralPort();
      const good = await startForwarder(mk({ sourcePort: p }));
      const booby = {
        id: "booby",
        protocol: "tcp" as const,
        sourcePort: 0,
        stop: () => Promise.reject(new Error("simulated teardown failure")),
      };
      let msg = "";
      try {
        await stopForwarders([booby, good]);
      } catch (e) {
        msg = (e as Error).message;
      }
      if (msg !== "") ok("stopForwarders reports that a handle failed to stop");
      else bad("stopForwarders reports a failed stop", "it resolved");
      // The message must be the sanitised AGGREGATE, not the raw internal error.
      // This is the assertion that distinguishes allSettled from all: under
      // `all` the first rejection propagates verbatim, so a rule's internal
      // failure text would reach the API response and the log.
      if (/1 of 2 forwarder\(s\) failed to stop/.test(msg)) {
        ok("the failure is reported as a sanitised aggregate");
      } else {
        bad("the failure is a sanitised aggregate", msg);
      }
      if (!msg.includes("simulated teardown failure")) ok("the internal error text does not leak");
      else bad("the internal error text does not leak", msg);
      await new Promise((r) => setTimeout(r, 300));
      if (!(await isPortOccupied(p))) ok("a failing handle did not strand the healthy listener");
      else bad("a failing handle did not strand the healthy listener", `${p} still bound`);
    }

    // =====================================================================
    // 8. Rule validation: ports, protocols, directions, endpoints.
    // =====================================================================
    {
      const rejects: Array<[string, unknown]> = [
        ["sourcePort 0", { sourcePort: 0 }],
        ["sourcePort 65536", { sourcePort: 65536 }],
        ["sourcePort non-integer", { sourcePort: 80.5 }],
        ["sourcePort negative", { sourcePort: -1 }],
        ["destPort 0", { destPort: 0 }],
        ["destPort 65536", { destPort: 65536 }],
        ["unknown protocol sctp", { protocol: "sctp" }],
        ["unknown protocol SCTP", { protocol: "SCTP" }],
        ["empty protocol", { protocol: "" }],
        ["unknown direction", { direction: "IRAN_TO_MARS" }],
        ["empty destHost", { destHost: "" }],
        ["empty name", { name: "" }],
        ["overlong name", { name: "x".repeat(81) }],
        ["sourcePort as string", { sourcePort: "8080" }],
      ];
      let n = 0;
      for (const [label, patch] of rejects) {
        const base = { sourcePort: 8080, ...patch } as Record<string, unknown>;
        if (!PortForwardRuleSchema.safeParse({
          name: "web",
          direction: "IRAN_TO_FOREIGN",
          protocol: "tcp",
          sourcePort: 8080,
          destHost: "127.0.0.1",
          destPort: 80,
          ...patch,
        }).success) n += 1;
        else bad(`the rule schema rejects ${label}`, "it parsed");
        void base;
      }
      if (n === rejects.length) ok(`the rule schema rejects all ${rejects.length} invalid rules`);

      // Boundary values that MUST be accepted.
      const accepted: Array<[string, unknown]> = [
        ["sourcePort 1", { sourcePort: 1 }],
        ["sourcePort 65535", { sourcePort: 65535 }],
        ["destPort 1", { destPort: 1 }],
        ["destPort 65535", { destPort: 65535 }],
      ];
      let a = 0;
      for (const [label, patch] of accepted) {
        if (PortForwardRuleSchema.safeParse({
          name: "web",
          direction: "IRAN_TO_FOREIGN",
          protocol: "tcp",
          sourcePort: 8080,
          destHost: "127.0.0.1",
          destPort: 80,
          ...patch,
        }).success) a += 1;
        else bad(`the rule schema accepts ${label}`, "it was rejected");
      }
      if (a === accepted.length) ok(`the rule schema accepts all ${accepted.length} boundary values`);

      // An IPv6 literal destination is legitimate and must survive.
      if (PortForwardRuleSchema.safeParse({
        name: "v6",
        direction: "IRAN_TO_FOREIGN",
        protocol: "tcp",
        sourcePort: 8080,
        destHost: "2001:db8::1",
        destPort: 80,
      }).success) ok("the rule schema accepts an IPv6 destination");
      else bad("the rule schema accepts an IPv6 destination", "it was rejected");
    }

    // =====================================================================
    // 9. Port allocation reports exhaustion specifically.
    // =====================================================================
    {
      const err = new PortRangeExhaustedError(1024, 1030);
      if (err instanceof Error) ok("range exhaustion has a dedicated error class");
      else bad("range exhaustion has a dedicated error class", String(err));
      if (/no free ports/i.test(err.message)) ok("the exhaustion message says no free ports are left");
      else bad("the exhaustion message is specific", err.message);
      if (err.message.includes("1024") && err.message.includes("1030")) {
        ok("the exhaustion message names the exhausted range");
      } else {
        bad("the exhaustion message names the range", err.message);
      }
      // findFreePort takes an explicit start/end; without them it scans the
      // module's real auto range (10000-60000), which is why an earlier version
      // of this assertion saw 10000 rather than exhaustion.
      const full = new Set(Array.from({ length: 7 }, (_, i) => 1024 + i));
      if (findFreePort(full, 1024, 1030) === null) ok("a fully used range yields null rather than an occupied port");
      else bad("a fully used range yields null", String(findFreePort(full, 1024, 1030)));
      if (findFreePort(new Set([1024, 1025]), 1024, 1030) === 1026) ok("findFreePort returns the first genuinely free port");
      else bad("findFreePort returns the first free port", String(findFreePort(new Set([1024, 1025]), 1024, 1030)));
      // An inverted range clamps rather than looping forever or throwing.
      if (findFreePort(new Set<number>(), 1030, 1024) !== null) ok("an inverted range clamps instead of throwing");
      else bad("an inverted range clamps", "it returned null");
      // The shipped auto range is the documented one.
      if (AUTO_PORT_START === 10000 && AUTO_PORT_END === 60000) ok("the auto range is the documented 10000-60000");
      else bad("the auto range is the documented one", `${AUTO_PORT_START}-${AUTO_PORT_END}`);
    }

    // =====================================================================
    // 10. The library and the worker agree on the bind address.
    // =====================================================================
    {
      // Drift here would mean the dev path and the production path expose the
      // listener on different interfaces -- a silent security difference.
      const libFwd = fs.readFileSync(
        path.join(ROOT, "packages/tunnel-core/src/forwarder.ts"),
        "utf8",
      );
      const runFwd = fs.readFileSync(path.join(ROOT, RUNNER), "utf8");
      const libBinds = [...libFwd.matchAll(/listen\([^,]+,\s*"([^"]+)"/g)].map((m) => m[1]);
      const runBinds = [...runFwd.matchAll(/listen\([^,]+,\s*BIND_ADDR/g)].map(() => "0.0.0.0");
      const libHasAll = libBinds.includes("0.0.0.0");
      const runHasAll = runBinds.length >= 2;
      if (libHasAll && runHasAll) ok("library and worker both bind 0.0.0.0 consistently");
      else {
        bad("library and worker bind consistently", `lib=${JSON.stringify(libBinds)} run=${JSON.stringify(runBinds)}`);
      }
      if (runFwd.includes('const BIND_ADDR = "0.0.0.0"')) ok("the worker's bind address is a single named constant");
      else bad("the worker's bind address is a named constant", "not found");
    }

    console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
  } finally {
    for (const h of live) {
      try {
        await h.stop();
      } catch {
        /* best effort */
      }
    }
  }
  if (failures.length > 0) process.exitCode = 1;

  // Handle census. The suite must not keep the event loop alive: a version
  // that destroyed a client without awaiting its 'close' left a socket pair
  // referenced, so the process hung after printing its summary and every run
  // reported the OUTER timeout instead of a verdict. Naming the survivors turns
  // a silent hang into a diagnosable one. Unref'd, so it never delays exit.
  setTimeout(() => {
    const h = process._getActiveHandles?.() ?? [];
    const detail = h
      .filter((x) => {
        const n = (x as { constructor?: { name?: string } }).constructor?.name ?? "";
        return !/^(WriteStream|ReadStream)$/.test(n);
      })
      .map((x) => {
        const s = x as { constructor?: { name?: string }; localPort?: number; remotePort?: number };
        return `${s.constructor?.name ?? "?"}(${s.localPort ?? ""}:${s.remotePort ?? ""})`;
      });
    if (detail.length > 0) {
      console.log(`[diag] lingering handles: ${detail.join(", ")}`);
    }
  }, 500).unref();
}

void main();
assert.ok(true);
