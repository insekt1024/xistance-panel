import { prisma } from "@xistance/db";
import { getEngine } from "@/lib/engine";
import { requireSession, json } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await requireSession(request, "ADMIN");
  if (!session.ok) return session.response;

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

  return json({
    tunnels: {
      total: tunnelCounts.reduce((s, r) => s + r._count._all, 0),
      byStatus: tunnelByStatus,
    },
    nodes: {
      total: nodeCounts.reduce((s, r) => s + r._count._all, 0),
      byStatus: nodeByStatus,
    },
    engine: {
      activeProcesses: engineSize,
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
  });
}
