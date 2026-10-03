/**
 * Disposal / cleanup tests (TASK-21).
 *
 * These exercise real sockets and real child processes -- no process-name
 * matching, no pkill, everything scoped to the handle under test, per the task's
 * technical note.
 *
 * The listener defect pinned here is real and was measured before the fix:
 * `net.Server.close()` does not complete while an established connection is
 * still open, so `ForwardHandle.stop()` never resolved and the stop request
 * hung for the lifetime of the client. A probe confirmed the close callback had
 * not fired 1.5s after close() with one idle client attached.
 */
import net from "node:net";
import { pickPort } from "./lib/pick-port";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  startForwarder,
  startForwarders,
  stopForwarders,
  type ForwardHandle,
} from "../packages/tunnel-core/src/forwarder.ts";
import { ChildProcessHandle, type ProcessSpec, type RetryScheduler } from "../packages/tunnel-core/src/process.ts";

const work = mkdtempSync(path.join(os.tmpdir(), "xistance-cleanup-"));

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

const idle: RetryScheduler = { setTimeout: () => 0 as never, clearTimeout: () => {}, now: () => 0 };

/**
 * A real upstream listener. The destination port must be LIVE: with a dead
 * port the client socket errors out on its own within milliseconds, the
 * connection never stays established, and a `server.close()` that would
 * otherwise hang completes anyway. That is how the first version of this test
 * passed against the unfixed code.
 */
let upstream: net.Server | null = null;
let upstreamPort = 0;
const upstreamSockets = new Set<net.Socket>();

const tcpRule = (sourcePort: number) => ({
  id: `t${sourcePort}`,
  name: `t${sourcePort}`,
  direction: "LOCAL" as const,
  protocol: "tcp" as const,
  sourcePort,
  destHost: "127.0.0.1",
  destPort: upstreamPort,
  enabled: true,
});

const udpRule = (sourcePort: number) => ({
  id: `u${sourcePort}`,
  name: `u${sourcePort}`,
  direction: "LOCAL" as const,
  protocol: "udp" as const,
  sourcePort,
  destHost: "127.0.0.1",
  destPort: 9,
  enabled: true,
});

/** A port that is free right now. */
/**
 * A port free right now, AND confirmed bindable on 0.0.0.0.
 *
 * Asking the OS for a free port on 127.0.0.1 is not enough. Windows hands out a
 * port from its ephemeral range, and binding that same port on 0.0.0.0 can
 * still fail with EACCES -- an observed, intermittent failure that killed a
 * previously green suite with no code change. The forwarder binds 0.0.0.0, so
 * that is the bind this test must actually be able to perform.
 *
 * Retried a few times: a transient reservation clears on its own.
 */

const canBind = async (port: number): Promise<boolean> => {
  try {
    const s = net.createServer();
    await new Promise<void>((res, rej) => {
      s.once("error", rej);
      s.listen(port, "0.0.0.0", () => res());
    });
    await new Promise<void>((r) => s.close(() => r()));
    return true;
  } catch {
    return false;
  }
};


const freePort = async (): Promise<number> => pickPort("0.0.0.0");

const settle = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  try {
    // A live upstream so forwarded connections stay established.
    upstream = net.createServer((c) => {
      upstreamSockets.add(c);
      c.on("close", () => upstreamSockets.delete(c));
      c.on("error", () => upstreamSockets.delete(c));
    });
    await new Promise<void>((res) => upstream!.listen(0, "127.0.0.1", () => res()));
    upstreamPort = (upstream!.address() as net.AddressInfo).port;

    // ---------------------------------------------------------------------
    // 1. A stop with a live client connected must complete, not hang.
    // ---------------------------------------------------------------------
    {
      const port = await freePort();
      const h = await startForwarder(tcpRule(port));
      const client = net.connect(port, "127.0.0.1");
      await new Promise((r) => client.once("connect", r));

      // Race stop() against a deadline: this is the assertion that failed
      // before the fix, where close() never called back.
      const raced = await Promise.race([
        h.stop().then(() => "stopped" as const),
        settle(4000).then(() => "hung" as const),
      ]);
      if (raced === "stopped") ok("stop() completes even with a client still connected");
      else bad("stop() completes even with a client still connected", "still pending after 4s");

      client.destroy();
      if (await canBind(port)) ok("the listening port is released after stop");
      else bad("the listening port is released after stop", `port ${port} is still bound`);
    }

    // ---------------------------------------------------------------------
    // 2. The client socket is actually severed, not just the listener.
    // ---------------------------------------------------------------------
    {
      const port = await freePort();
      const h = await startForwarder(tcpRule(port));
      const client = net.connect(port, "127.0.0.1");
      await new Promise((r) => client.once("connect", r));
      let clientClosed = false;
      client.once("close", () => {
        clientClosed = true;
      });
      await h.stop();
      await settle(200);
      if (clientClosed) ok("stop() severs the established client connection");
      else bad("stop() severs the established client connection", "the client socket stayed open");
      client.destroy();
    }

    // ---------------------------------------------------------------------
    // 3. stop() is idempotent for TCP and UDP.
    // ---------------------------------------------------------------------
    {
      const tPort = await freePort();
      const uPort = await freePort();
      const t = await startForwarder(tcpRule(tPort));
      const u = await startForwarder(udpRule(uPort));
      await t.stop();
      const second = await Promise.race([
        t.stop().then(() => "ok" as const, () => "rejected" as const),
        settle(2000).then(() => "hung" as const),
      ]);
      if (second === "ok") ok("a repeated TCP stop resolves instead of hanging");
      else bad("a repeated TCP stop resolves", "hung");

      const uSecond = await Promise.race([
        u.stop().then(() => "ok" as const, () => "rejected" as const),
        settle(2000).then(() => "hung" as const),
      ]);
      if (uSecond === "ok") ok("a repeated UDP stop resolves instead of throwing");
      else bad("a repeated UDP stop resolves", "hung or rejected");
    }

    // ---------------------------------------------------------------------
    // 4. A mid-batch bind failure releases the ports already bound.
    // ---------------------------------------------------------------------
    {
      const p1 = await freePort();
      // Occupy a port so binding it second must fail.
      const blocker = net.createServer();
      await new Promise<void>((r) => blocker.listen(p1, "0.0.0.0", () => r()));
      const p2 = await freePort();
      let threw = false;
      try {
        await startForwarders([tcpRule(p2), tcpRule(p1), tcpRule(await freePort())]);
      } catch {
        threw = true;
      }
      await new Promise<void>((r) => blocker.close(() => r()));
      if (threw) ok("a mid-batch bind failure is reported");
      else bad("a mid-batch bind failure is reported", "startForwarders resolved");
      if (await canBind(p2)) ok("ports bound before a batch failure are released");
      else bad("ports bound before a batch failure are released", `port ${p2} is still bound`);
    }

    // ---------------------------------------------------------------------
    // 5. stopForwarders disposes every handle even when one fails.
    // ---------------------------------------------------------------------
    {
      const good1 = await freePort();
      const good2 = await freePort();
      const handles: ForwardHandle[] = [
        await startForwarder(tcpRule(good1)),
        // A handle whose stop always rejects, standing in for a resource that
        // cannot be closed.
        { id: "bad", protocol: "tcp", sourcePort: 0, stop: () => Promise.reject(new Error("boom")) },
        await startForwarder(tcpRule(good2)),
      ];
      let rejected = false;
      try {
        await stopForwarders(handles);
      } catch {
        rejected = true;
      }
      if (rejected) ok("a failed handle is reported rather than swallowed");
      else bad("a failed handle is reported", "stopForwarders resolved");
      if (await canBind(good1)) ok("a failing handle does not strand the other listeners (1)");
      else bad("a failing handle does not strand the other listeners (1)", `port ${good1} still bound`);
      if (await canBind(good2)) ok("a failing handle does not strand the other listeners (2)");
      else bad("a failing handle does not strand the other listeners (2)", `port ${good2} still bound`);
    }

    // ---------------------------------------------------------------------
    // 6. The cleanup error carries no rule internals.
    // ---------------------------------------------------------------------
    {
      const handles: ForwardHandle[] = [
        {
          id: "leaky",
          protocol: "tcp",
          sourcePort: 4242,
          stop: () => Promise.reject(new Error("secret-token-abc123 in command args")),
        },
      ];
      let message = "";
      try {
        await stopForwarders(handles);
      } catch (e) {
        message = (e as Error).message;
      }
      if (message && !message.includes("secret-token-abc123")) {
        ok("the aggregated cleanup error does not echo underlying detail");
      } else {
        bad("the aggregated cleanup error does not echo underlying detail", message);
      }
    }

    // ---------------------------------------------------------------------
    // 7. A child process is really gone after stop, and not by name-matching.
    // ---------------------------------------------------------------------
    {
      const marker = path.join(work, "child-alive.txt");
      const script = `require("fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
      const spec: ProcessSpec = {
        id: "keeper",
        name: "keeper",
        command: [process.execPath, "-e", script],
        dataDir: work,
        unitName: "xt-keeper",
        autorestart: true,
        retry: { baseDelayMs: 60_000, maxDelayMs: 60_000, maxAttempts: null },
      };
      const h = new ChildProcessHandle(spec, idle);
      await h.start();
      await settle(250);
      const pid = await h.pid();
      const alive = (): boolean => {
        if (!pid) return false;
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      if (alive()) ok("the managed child is running before stop");
      else bad("the managed child is running before stop", "no live pid");
      await h.stop();
      await settle(300);
      if (!alive()) ok("the managed child is terminated by stop()");
      else bad("the managed child is terminated by stop()", `pid ${pid} survived`);

      // The respawn must not silently replace it: the child writes its own pid
      // to the marker, so a replacement would overwrite it with a live pid.
      //
      // Wait for the marker before reading it. It was read straight after
      // `settle(300)`, which is a race: under aggregate load (dozens of suites in
      // parallel) the child's write can land later than that, and the suite then
      // reported "no marker written" -- which reads like a respawn defect but is
      // only the test being early. It passed 3/3 standalone and failed once in the
      // aggregate, which is the signature of a race rather than a defect.
      let recorded = "";
      for (let i = 0; i < 40 && !recorded; i++) {
        if (existsSync(marker)) recorded = readFileSync(marker, "utf8").trim();
        if (!recorded) await settle(50);
      }
      const stillLive = (() => {
        const n = Number(recorded);
        if (!Number.isFinite(n) || n <= 0) return false;
        try {
          process.kill(n, 0);
          return true;
        } catch {
          return false;
        }
      })();
      if (recorded && !stillLive) ok("no replacement child was spawned after stop");
      else if (!recorded) bad("the child recorded its pid for inspection", "no marker written");
      else bad("no replacement child was spawned after stop", `pid ${recorded} is live`);

      // Nothing may be left listening or running for this handle.
      if ((await h.isRunning()) === false) ok("the handle reports not-running after stop");
      else bad("the handle reports not-running after stop", "isRunning() is true");
    }

    console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    // Release the fixture's own sockets, otherwise a live accepted connection
    // keeps the event loop alive and the test process never exits.
    for (const s of upstreamSockets) {
      try {
        s.destroy();
      } catch {
        /* already gone */
      }
    }
    upstreamSockets.clear();
    if (upstream) {
      try {
        upstream.close();
      } catch {
        /* already closed */
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
}

void main();
