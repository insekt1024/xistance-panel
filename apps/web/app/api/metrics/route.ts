import { prisma } from "@xistance/db";
import { getEngine } from "@/lib/engine";
import { apiError, requireSession, json } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { cached } from "@/lib/query-cache";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await requireSession(request, "ADMIN");
  if (!session.ok) return session.response;
  const rl = rateLimit(`metrics:${session.user.id}`, 20, 60_000);
  if (!rl.ok) return apiError("Too many requests, slow down", 429);

  const data = await cached("metrics:summary", 20_000, async () => {
    const [
      tunnelCounts,
      nodeCounts,
      traffic,
    ] = await Promise.all([
      prisma.tunnel.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.node.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.trafficSample.aggregate({
        _sum: { bytesIn: true, bytesOut: true },
        where: {
          ts: { gte: new Date(Date.now() - 24 * 60 * 60_000) },
        },
      }),
    ]);

    const tunnelByStatus: Record<string, number> = {};
    for (const row of tunnelCounts) {
      tunnelByStatus[row.status] = row._count._all;
    }

    const nodeByStatus: Record<string, number> = {};
    for (const row of nodeCounts) {
      nodeByStatus[row.status] = row._count._all;
    }

    let engineSize = 0;
    try {
      engineSize = getEngine().size();
    } catch {
      // engine unavailable
    }

    const mem = process.memoryUsage();

    return {
      tunnels: {
        total: tunnelCounts.reduce((s, r) => s + r._count._all, 0),
        byStatus: tunnelByStatus,
      },
      nodes: {
        total: nodeCounts.reduce((s, r) => s + r._count._all, 0),
        byStatus: nodeByStatus,
      },
      engine: {
        // Managed tunnel runtimes (not OS processes) — see engine.size().
        managedTunnels: engineSize,
      },
      traffic: {
        window: "24h",
        bytesIn: Number(traffic._sum.bytesIn ?? 0),
        bytesOut: Number(traffic._sum.bytesOut ?? 0),
      },
      uptime: process.uptime(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
      timestamp: new Date().toISOString(),
    };
  });

  return json(data);
}
