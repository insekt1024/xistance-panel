import { prisma } from "@xistance/db";
import { getEngine } from "./engine";

// ---------------------------------------------------------------------------
// Traffic sampler: every 60s, snapshot every engine-managed tunnel and persist
// a TrafficSample row for the dashboard charts. Started from instrumentation.
// Old samples are pruned once per hour (not on every tick) to keep per-tick
// write load minimal.
// ---------------------------------------------------------------------------

const SAMPLE_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 60 * 60_000;
const RETAIN_MS = 7 * 24 * 3600_000;
const MAX_BATCH = 50;
// Bound per-tick fan-out: each snapshot() can spawn SSH sessions on remote
// nodes, so unbounded Promise.all over all tunnels is a thundering herd.
const SNAPSHOT_CONCURRENCY = 5;
// Hard cap: skip the tick rather than stampede hundreds of SSH sessions.
const MAX_MANAGED_PER_TICK = 200;

let started = false;
let running = false;

export function startTrafficSampler(): void {
  if (started) return;
  started = true;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const engine = getEngine();
      const tunnels = await prisma.tunnel.findMany({ select: { id: true } });
      const now = Date.now();
      const managed = tunnels.filter((t) => engine.has(t.id));
      if (managed.length > MAX_MANAGED_PER_TICK) {
        console.error(
          `[sampler] skipping tick: ${managed.length} managed tunnels exceeds cap of ${MAX_MANAGED_PER_TICK}`,
        );
        return;
      }
      // Snapshot with a bounded worker pool instead of Promise.all over
      // everything (each snapshot may open SSH sessions to remote nodes).
      const snaps: Array<Awaited<ReturnType<typeof engine.snapshot>>> = new Array(
        managed.length,
      ).fill(null);
      let next = 0;
      const workers = Array.from(
        { length: Math.min(SNAPSHOT_CONCURRENCY, managed.length) },
        async () => {
          while (next < managed.length) {
            const i = next;
            next += 1;
            try {
              snaps[i] = await engine.snapshot(managed[i].id);
            } catch (err) {
              // Isolate per-tunnel failures so one bad tunnel doesn't
              // starve the rest of this worker's queue for the tick.
              console.error(`[sampler] snapshot failed for ${managed[i].id}:`, err);
              snaps[i] = null;
            }
          }
        },
      );
      await Promise.all(workers);
      const rows: Array<{
        tunnelId: string;
        bytesIn: bigint;
        bytesOut: bigint;
        speedInBps: number;
        speedOutBps: number;
        ts: Date;
      }> = [];
      for (let i = 0; i < managed.length; i++) {
        const snap = snaps[i];
        if (!snap || snap.status !== "running") continue;
        rows.push({
          tunnelId: managed[i].id,
          bytesIn: BigInt(Math.floor(snap.bytesIn)),
          bytesOut: BigInt(Math.floor(snap.bytesOut)),
          speedInBps: Math.floor(snap.speedInBps),
          speedOutBps: Math.floor(snap.speedOutBps),
          ts: new Date(now),
        });
      }
      // Batch inserts (chunked to satisfy parameter limits on any provider).
      for (let i = 0; i < rows.length; i += MAX_BATCH) {
        await prisma.trafficSample.createMany({
          data: rows.slice(i, i + MAX_BATCH),
        });
      }
    } catch (err) {
      console.error("[sampler] traffic sample failed:", err);
    } finally {
      running = false;
    }
  }, SAMPLE_INTERVAL_MS);
  timer.unref();

  // Prune retained samples once per hour (cheap, index-backed).
  const pruneTimer = setInterval(async () => {
    try {
      await prisma.trafficSample.deleteMany({
        where: { ts: { lt: new Date(Date.now() - RETAIN_MS) } },
      });
    } catch (err) {
      console.error("[sampler] prune failed:", err);
    }
  }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();
}