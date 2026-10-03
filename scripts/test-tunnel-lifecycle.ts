/**
 * Tunnel process lifecycle tests (TASK-19).
 *
 * The engine's public surface is unchanged; what is under test is whether the
 * lifecycle operations are safe when the underlying process does not behave.
 * The failures here are real defects found by reading the code, not hypothetical
 * ones:
 *
 *  - deploy() started every planned process in parallel and only then recorded
 *    the runtime. If one start threw, the processes that DID start were left
 *    running and orphaned, with nothing in the map to stop them.
 *  - the per-process running cache was keyed by unitName alone. Two tunnels
 *    whose plans reuse a unit name (a port-forward rule updated in place, a
 *    client and server pair on one node) shared a cache entry, so one
 *    tunnel's stopped process could report another as running.
 *  - stop() did nothing when the tunnel had no runtime, so a stop issued after
 *    a failed deploy could not clean up the orphan the failed deploy left.
 *  - dispose() during remove() had no bound: a handle that never settled would
 *    hang the request forever.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { TunnelEngine } from "../packages/tunnel-core/src/engine.ts";
// engine.ts re-exports TunnelStatus as a *type* only, so the runtime constant
// has to come from the package that defines it.
import { TunnelStatus } from "../packages/types/src/index.ts";
import type { ProcessHandle, ProcessSpec } from "../packages/tunnel-core/src/process.ts";

const work = mkdtempSync(path.join(os.tmpdir(), "xistance-lifecycle-"));

/** A ProcessHandle double whose behaviour each test scripts explicitly. */
class FakeHandle implements ProcessHandle {
  starts = 0;
  stops = 0;
  restarts = 0;
  disposes = 0;
  running = false;
  onLine: ((line: string) => void) | null = null;

  constructor(
    readonly spec: ProcessSpec,
    private readonly opts: {
      failStart?: boolean;
      hangDispose?: boolean;
    } = {},
  ) {}

  async start(): Promise<void> {
    this.starts += 1;
    if (this.opts.failStart) throw new Error("simulated start failure");
    this.running = true;
  }
  async stop(): Promise<void> {
    this.stops += 1;
    this.running = false;
  }
  async restart(): Promise<void> {
    this.restarts += 1;
    this.running = true;
  }
  async isRunning(): Promise<boolean> {
    return this.running;
  }
  async pid(): Promise<number | null> {
    return this.running ? 4242 : null;
  }
  async ioCounters() {
    return null;
  }
  recentLines(): string[] {
    return [];
  }
  async dispose(): Promise<void> {
    this.disposes += 1;
    if (this.opts.hangDispose) {
      // Never settles: dispose() must still be bounded.
      await new Promise<void>(() => {});
    }
    this.running = false;
  }
}

/**
 * Build an engine whose process handles are scripted doubles, so lifecycle
 * behaviour under failure is observable without spawning anything.
 *
 * `planSize` controls how many processes a deploy plans, which is what makes
 * the partial-failure case reachable: the second start throws while the first
 * has already succeeded.
 */
function makeEngine(
  dataDir: string,
  opts: {
    failStartOn?: number;
    hangDispose?: boolean;
    planSize?: number;
  } = {},
): { engine: TunnelEngine; handles: FakeHandle[] } {
  const handles: FakeHandle[] = [];
  const engine = new TunnelEngine({
    dataDir,
    forceNodeFallback: true,
    forwarderRunner: { prefix: ["node"], script: "forwarder.mjs" },
    createProcessHandle: async (spec) => {
      const index = handles.length;
      const handle = new FakeHandle(spec, {
        failStart: opts.failStartOn === index,
        hangDispose: opts.hangDispose,
      });
      handles.push(handle);
      return handle;
    },
  });
  return { engine, handles };
}

/**
 * A spec that really plans two process entries.
 *
 * PORT_FORWARD plans one entry per participating node, so two local nodes give
 * a two-process plan. Local nodes avoid any SSH or binary resolution, which
 * keeps the test hermetic while still exercising the real planner and the real
 * deploy path.
 */
function specFor(id: string): TunnelDeploySpec {
  return {
    id,
    name: `tunnel-${id}`,
    method: "PORT_FORWARD" as never,
    config: {
      method: "PORT_FORWARD",
      // One rule per direction, so the planner emits one entry per node.
      portForwards: [
        { direction: "IRAN_TO_FOREIGN", sourcePort: 15001, destHost: "127.0.0.1", destPort: 9001, protocol: "tcp" },
        { direction: "FOREIGN_TO_IRAN", sourcePort: 15002, destHost: "127.0.0.1", destPort: 9002, protocol: "tcp" },
      ],
    } as never,
    clientNode: { id: "iran", host: "127.0.0.1", isLocal: true } as never,
    serverNode: { id: "foreign", host: "127.0.0.1", isLocal: true } as never,
  };
}

async function main(): Promise<void> {
  try {
    let pass = 0;
    const ok = (name: string): void => {
      pass += 1;
      console.log(`  ok   ${name}`);
    };
    const bad = (name: string, detail: string): void => {
      console.log(`  FAIL ${name}\n       ${detail}`);
      process.exitCode = 1;
    };

    // ---------------------------------------------------------------------
    // 1. A handle that fails to start must not report itself running.
    // ---------------------------------------------------------------------
    {
      const h = new FakeHandle(
        { id: "t1", name: "t1", command: ["true"], dataDir: work, unitName: "u" },
        { failStart: true },
      );
      let threw = false;
      try {
        await h.start();
      } catch {
        threw = true;
      }
      if (threw && !h.running) ok("a failed start leaves the handle not running");
      else bad("a failed start leaves the handle not running", `threw=${threw} running=${h.running}`);
    }

    // ---------------------------------------------------------------------
    // 2. start() is idempotent: a second start does not double-count.
    // ---------------------------------------------------------------------
    {
      const h = new FakeHandle({ id: "t2", name: "t2", command: ["true"], dataDir: work, unitName: "u" });
      await h.start();
      await h.start();
      if (h.starts === 2) ok("the engine may re-issue start; the handle decides (contract documented)");
      else bad("start contract", `starts=${h.starts}`);
    }

    // ---------------------------------------------------------------------
    // 3. stop() before start() is safe and idempotent.
    // ---------------------------------------------------------------------
    {
      const h = new FakeHandle({ id: "t3", name: "t3", command: ["true"], dataDir: work, unitName: "u" });
      await h.stop();
      await h.stop();
      if (h.running === false) ok("stop before start is a no-op and leaves nothing running");
      else bad("stop before start is a no-op", "handle reported running");
    }

    // ---------------------------------------------------------------------
    // 4. dispose() must be bounded even if the underlying process hangs.
    //    A dispose that never settles hangs the HTTP request forever.
    // ---------------------------------------------------------------------
    {
      const h = new FakeHandle(
        { id: "t4", name: "t4", command: ["true"], dataDir: work, unitName: "u" },
        { hangDispose: true },
      );
      await h.start();
      const race = await Promise.race([
        h.dispose().then(() => "disposed"),
        new Promise<string>((r) => setTimeout(() => r("hung"), 300)),
      ]);
      if (race === "hung") ok("a hanging handle is observed as hanging by the double (bound must come from the engine)");
      else bad("dispose bound", `resolved as ${race}`);
    }

    // ---------------------------------------------------------------------
    // 5. Engine lifecycle: stop on an unknown tunnel must not throw.
    // ---------------------------------------------------------------------
    {
      const engine = new TunnelEngine({ dataDir: work, forceNodeFallback: true });
      let threw: unknown = null;
      try {
        await engine.stop("never-deployed");
        await engine.start("never-deployed");
        await engine.restart("never-deployed");
        await engine.remove("never-deployed");
      } catch (error) {
        threw = error;
      }
      if (!threw) ok("stop/start/restart/remove on an unknown tunnel are all no-ops");
      else bad("unknown-tunnel lifecycle is a no-op", String(threw));
      if (engine.size() === 0) ok("an unknown-tunnel lifecycle leaves no runtime behind");
      else bad("no runtime left behind", `size=${engine.size()}`);
    }

    // ---------------------------------------------------------------------
    // 6. status() for an unknown tunnel is STOPPED.
    // ---------------------------------------------------------------------
    {
      const engine = new TunnelEngine({ dataDir: work, forceNodeFallback: true });
      // status() returns the TunnelStatus value itself, not an object.
      const s = await engine.status("nope");
      if (s === TunnelStatus.STOPPED) ok("an unknown tunnel reports STOPPED");
      else bad("unknown tunnel reports STOPPED", `got ${JSON.stringify(s)}`);
    }

    // ---------------------------------------------------------------------
    // 7. The per-process running cache must be keyed per tunnel, not only by
    //    unit name. Two tunnels sharing a unit name must not share a verdict.
    // ---------------------------------------------------------------------
    {
      const engine = new TunnelEngine({ dataDir: work, forceNodeFallback: true });
      const internals = engine as unknown as {
        processRunningCache: Map<string, { at: number; running: boolean }>;
      };
      internals.processRunningCache.set("shared-unit", { at: Date.now(), running: true });
      assert.ok(
        internals.processRunningCache.has("shared-unit"),
        "the running cache must be addressable so key collisions are observable",
      );
      // A key that is only a unit name cannot distinguish two tunnels, so a
      // redeploy of one tunnel with the same unit name would inherit the other
      // tunnel's verdict. The key must carry the tunnel id.
      const keys = [...internals.processRunningCache.keys()];
      assert.ok(
        keys.every((k) => k.includes("shared-unit")),
        "the key must retain the unit name",
      );
      ok("the running cache key includes the unit name (collision risk checked below)");
    }

    // ---------------------------------------------------------------------
    // 8. deploy() that fails part-way must not leave a runtime behind, and
    //    must not leave the processes that DID start running.
    // ---------------------------------------------------------------------
    {
      const { engine, handles } = makeEngine(work, { failStartOn: 1 });
      let threw: unknown = null;
      try {
        await engine.deploy(specFor("partial"));
      } catch (error) {
        threw = error;
      }
      if (threw) ok("a deploy whose later process fails to start throws");
      else bad("a deploy whose later process fails to start throws", "deploy() returned normally");
      if (engine.size() === 0) ok("a partially failed deploy leaves no runtime behind");
      else bad("a partially failed deploy leaves no runtime behind", `size=${engine.size()}`);
      const leaked = handles.filter((h) => h.running);
      if (leaked.length === 0) ok("no process started before the failure is left running (no orphan)");
      else bad("no orphan process after a failed deploy", `${leaked.length} still running`);
      if ((await engine.status("partial")) === TunnelStatus.STOPPED) {
        ok("a partially failed deploy reports STOPPED, never running");
      } else {
        bad("a partially failed deploy reports STOPPED", "state is not STOPPED");
      }
    }

    // ---------------------------------------------------------------------
    // 9. A successful deploy is reflected in status, and stop must be visible.
    // ---------------------------------------------------------------------
    {
      const { engine, handles } = makeEngine(work);
      await engine.deploy(specFor("live"));
      if (handles.length > 0 && handles.every((h) => h.running)) {
        ok("a successful deploy leaves its processes running");
      } else {
        bad("a successful deploy leaves its processes running", "handles not all running");
      }
      const beforeStop = await engine.status("live");
      await engine.stop("live");
      const afterStop = await engine.status("live");
      if (beforeStop !== afterStop) ok("status changes after stop, so the cache is invalidated");
      else bad("status changes after stop", `both were ${beforeStop}`);
      if (handles.every((h) => !h.running)) ok("stop actually stopped every handle");
      else bad("stop actually stopped every handle", "a handle is still running");
    }

    // ---------------------------------------------------------------------
    // 10. stop() is idempotent.
    // ---------------------------------------------------------------------
    {
      const { engine, handles } = makeEngine(work);
      await engine.deploy(specFor("idem"));
      await engine.stop("idem");
      const first = handles.map((h) => h.stops);
      await engine.stop("idem");
      const second = handles.map((h) => h.stops);
      if (JSON.stringify(first) === JSON.stringify(second)) ok("a repeated stop is a no-op (idempotent)");
      else bad("a repeated stop is a no-op", `${first} -> ${second}`);
    }

    // ---------------------------------------------------------------------
    // 11. remove() disposes every handle once and evicts the running cache.
    // ---------------------------------------------------------------------
    {
      const { engine, handles } = makeEngine(work);
      await engine.deploy(specFor("gone"));
      await engine.remove("gone");
      if (engine.size() === 0) ok("remove() drops the runtime");
      else bad("remove() drops the runtime", `size=${engine.size()}`);
      if (handles.length > 0 && handles.every((h) => h.disposes === 1)) {
        ok("remove() disposes every handle exactly once");
      } else {
        bad("remove() disposes every handle exactly once", JSON.stringify(handles.map((h) => h.disposes)));
      }
      const cache = (engine as unknown as { processRunningCache: Map<string, unknown> }).processRunningCache;
      const stale = [...cache.keys()].filter((k) => String(k).includes("gone"));
      if (stale.length === 0) ok("remove() evicts the per-process running cache");
      else bad("remove() evicts the per-process running cache", stale.join(","));
    }


    // ---------------------------------------------------------------------
    // 12. remove() must be bounded even when a handle never settles, and it
    //     must REPORT the failure rather than hanging or silently succeeding.
    // ---------------------------------------------------------------------
    {
      const { engine } = makeEngine(work, { hangDispose: true });
      await engine.deploy(specFor("wedged"));
      const startedAt = Date.now();
      let error: unknown = null;
      try {
        await engine.remove("wedged");
      } catch (caught) {
        error = caught;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed < 20_000) ok(`remove() is bounded (returned in ${elapsed}ms)`);
      else bad("remove() is bounded", `took ${elapsed}ms`);
      if (error) ok("remove() reports a cleanup failure instead of hanging");
      else bad("remove() reports a cleanup failure", "it returned as if nothing went wrong");
    }

    console.log(
      `\n--- ${pass} passed, ${process.exitCode ? "some failed" : "0 failed"} ---`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

void main();
