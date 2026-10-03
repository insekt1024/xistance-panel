import { prisma } from "@xistance/db";
import { getEngine } from "@/lib/engine";
import { apiError, requireSession, json } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { CACHE_METRICS, cacheAge, cached } from "@/lib/query-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Auth itself reads the database (the session row), so a dead database used
  // to reject here and produce a bare 500 with an empty body -- the one moment
  // an operator most needs this endpoint. Catch it and answer with a named,
  // structured payload instead. Only a genuine auth DECISION (no session, or
  // an insufficient role) may answer 401/403; an auth system that cannot reach
  // its own store is a dependency failure, not a rejected caller.
  let session: Awaited<ReturnType<typeof requireSession>>;
  try {
    session = await requireSession(request, "ADMIN");
  } catch {
    return json(
      {
        ok: false,
        error: "unavailable",
        reason: "The session store could not be reached, so this request cannot be authenticated.",
        tunnels: { total: 0, byStatus: {}, byState: {}, available: false },
        nodes: { total: 0, byStatus: {}, available: false },
        engine: { managedTunnels: 0, available: false },
        diagnostics: { byState: {}, byErrorCategory: {}, retrying: 0, exhausted: 0, tracked: 0 },
        traffic: { window: "24h", bytesIn: 0, bytesOut: 0, available: false },
        timestamp: new Date().toISOString(),
      },
      503,
    );
  }
  if (!session.ok) return session.response;
  const rl = rateLimit(`metrics:${session.user.id}`, 20, 60_000);
  if (!rl.ok) return apiError("Too many requests, slow down", 429);

  // The whole summary is computed inside one cached, single-flight call, so the
  // per-request cost is a Map lookup and a small serialisation -- never a
  // database scan. The 20s TTL is the bound on how stale an operator can be.
  const CACHE_KEY = `${CACHE_METRICS}summary`;
  const data = await cached(CACHE_KEY, 20_000, async () => {
    // A failing dependency must be REPRESENTED, not thrown. The three queries
    // below used to reject the whole handler, so a database hiccup turned
    // /api/metrics into a 500 with a stack trace -- the opposite of telemetry,
    // which is most needed exactly when things are broken. Each query is
    // isolated, and the payload names the parts that are unavailable.
    const [tunnelCounts, nodeCounts, traffic] = await Promise.all([
      prisma.tunnel.groupBy({ by: ["status", "state"], _count: { _all: true } }).catch(() => null),
      prisma.node.groupBy({ by: ["status"], _count: { _all: true } }).catch(() => null),
      prisma.trafficSample.aggregate({
        _sum: { bytesIn: true, bytesOut: true },
        where: { ts: { gte: new Date(Date.now() - 24 * 60 * 60_000) } },
      }).catch(() => null),
    ]);

    // `status` is what the operator asked for; `state` is what the supervisor
    // reported. They diverge for a degraded tunnel, so both are reported -- a
    // single "byStatus" map cannot show a tunnel that is wanted-running but is
    // actually errored.
    const byStatus: Record<string, number> = {};
    const byState: Record<string, number> = {};
    for (const row of tunnelCounts ?? []) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + row._count._all;
      byState[row.state] = (byState[row.state] ?? 0) + row._count._all;
    }

    const nodeByStatus: Record<string, number> = {};
    for (const row of nodeCounts ?? []) {
      nodeByStatus[row.status] = (nodeByStatus[row.status] ?? 0) + row._count._all;
    }

    // One pass over the engine's in-memory diagnostics, not a per-tunnel call.
    let engineSize = 0;
    let diagnostics = { byState: {}, byErrorCategory: {}, retrying: 0, exhausted: 0, tracked: 0 };
    let engineAvailable = true;
    try {
      const engine = getEngine();
      engineSize = engine.size();
      diagnostics = engine.aggregateDiagnostics();
    } catch {
      // The engine is independent of the database; if it is gone, say so
      // rather than reporting zero managed tunnels as if that were the truth.
      engineAvailable = false;
    }

    const mem = process.memoryUsage();
    // Cumulative CPU totals, NOT a percentage. A percentage has to be derived by
    // differencing two samples, but this summary is served from a 20s cache, so
    // two samples inside that window return identical counters and any rate
    // computed from them is a silent zero -- the shape of number that looks like
    // a healthy idle CPU reading. Cumulative counters stay correct under caching:
    // differencing them over a window longer than the TTL yields a real rate.
    const cpu = process.cpuUsage();

    return {
      ok: tunnelCounts !== null && engineAvailable,
      tunnels: {
        total: (tunnelCounts ?? []).reduce((s, r) => s + r._count._all, 0),
        byStatus,
        byState,
        available: tunnelCounts !== null,
      },
      nodes: {
        total: (nodeCounts ?? []).reduce((s, r) => s + r._count._all, 0),
        byStatus: nodeByStatus,
        available: nodeCounts !== null,
      },
      engine: {
        // Managed tunnel runtimes (not OS processes) -- see engine.size().
        managedTunnels: engineSize,
        available: engineAvailable,
      },
      // No summary text, no argv, no environment: categories and counts only.
      diagnostics,
      traffic: {
        window: "24h",
        bytesIn: Number(traffic?._sum.bytesIn ?? 0),
        bytesOut: Number(traffic?._sum.bytesOut ?? 0),
        available: traffic !== null,
      },
      uptime: process.uptime(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
      // Microseconds of CPU, monotonic since process start. A caller computes a
      // rate by differencing two readings taken further apart than cache.ttlMs.
      // `memory.rss` above is a point-in-time reading and IS affected by the
      // cache; these counters are not, which is why both are reported rather
      // than one "cpu" figure that silently means "0% while cached".
      cpu: { userMicros: cpu.user, systemMicros: cpu.system, totalMicros: cpu.user + cpu.system },
      // When these numbers were actually computed. Without it a summary served
      // 19 minutes ago renders exactly like a fresh one.
      generatedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    };
  });

  return json({
    ...data,
    // Read from the cache rather than stamped here, so a served-from-cache
    // response reports the AGE OF THE DATA, not the age of the HTTP call.
    cache: { key: CACHE_KEY, ttlMs: 20_000, ageMs: cacheAge(CACHE_KEY) },
  });
}
