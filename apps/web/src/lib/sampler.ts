import { prisma } from "@xistance/db";
import { getEngine } from "./engine";

// ---------------------------------------------------------------------------
// Traffic sampler: every 30s, snapshot every engine-managed tunnel and persist
// a TrafficSample row for the dashboard charts. Started from instrumentation.
// ---------------------------------------------------------------------------

let started = false;

export function startTrafficSampler(): void {
  if (started) return;
  started = true;
  const timer = setInterval(async () => {
    try {
      const engine = getEngine();
      const tunnels = await prisma.tunnel.findMany({ select: { id: true } });
      const now = Date.now();
      for (const t of tunnels) {
        if (!engine.has(t.id)) continue;
        const snap = await engine.snapshot(t.id);
        if (!snap || snap.status !== "running") continue;
        await prisma.trafficSample.create({
          data: {
            tunnelId: t.id,
            bytesIn: BigInt(Math.floor(snap.bytesIn)),
            bytesOut: BigInt(Math.floor(snap.bytesOut)),
            speedInBps: Math.floor(snap.speedInBps),
            speedOutBps: Math.floor(snap.speedOutBps),
            ts: new Date(now),
          },
        });
      }
      // prune samples older than 7 days
      await prisma.trafficSample.deleteMany({
        where: { ts: { lt: new Date(Date.now() - 7 * 24 * 3600_000) } },
      });
    } catch {
      /* sampler must never crash the server */
    }
  }, 30_000);
  timer.unref();
}
