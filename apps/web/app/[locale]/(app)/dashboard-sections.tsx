import { prisma } from "@xistance/db";
import { getEngine } from "@/lib/engine";
import { CACHE_DASHBOARD_TRAFFIC, cached } from "@/lib/query-cache";
import { aggregateTrafficSince } from "@/lib/traffic";
import { ActivityPanel, StatCards, TrafficPanel, TunnelsTable } from "./dashboard-stats";
import { DashboardSkeleton } from "./dashboard-skeleton";

const CHART_BUCKET_MS = 30 * 60_000;

export async function StatsSection() {
  const [tunnels, totalTunnels, totalNodes, onlineNodes, portForwards] = await Promise.all([
    prisma.tunnel.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true, name: true, method: true, state: true, port: true,
        clientNode: { select: { name: true } },
        serverNode: { select: { name: true } },
      },
    }),
    prisma.tunnel.count(),
    prisma.node.count(),
    prisma.node.count({ where: { status: "online" } }),
    prisma.portForward.count(),
  ]);

  const engine = getEngine();
  const liveTunnels = await Promise.all(
    tunnels.map(async (tun) => {
      let live = tun.state;
      if (engine.has(tun.id)) {
        try {
          live = await engine.status(tun.id);
        } catch {
          // One bad tunnel must not crash the whole section.
          live = "unknown";
        }
      }
      return { ...tun, liveState: live };
    }),
  );

  const running = liveTunnels.filter((x) => x.liveState === "running").length;

  return (
    <>
      <StatCards
        totalTunnels={totalTunnels}
        activeTunnels={running}
        totalNodes={totalNodes}
        onlineNodes={onlineNodes}
        portForwards={portForwards}
      />
      <TunnelsTable
        tunnels={liveTunnels.map((x) => ({
          id: x.id,
          name: x.name,
          method: x.method,
          status: x.liveState,
          port: x.port,
          clientNode: x.clientNode?.name ?? "—",
          serverNode: x.serverNode?.name ?? "—",
        }))}
      />
    </>
  );
}

export async function TrafficSection() {
  const HOUR_MS = 3600_000;
  const samples = await cached(CACHE_DASHBOARD_TRAFFIC, 10_000, () =>
    // eslint-disable-next-line react-hooks/purity
    aggregateTrafficSince(new Date(Date.now() - 24 * HOUR_MS), CHART_BUCKET_MS),
  );

  return <TrafficPanel samples={samples} />;
}

export async function ActivitySection() {
  const recentLogs = await prisma.auditLog.findMany({
    include: { actor: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: 8,
  });

  return (
    <ActivityPanel
      recentActivity={recentLogs.map((l) => ({
        action: l.action,
        target: l.target ?? "",
        actor: l.actor?.name ?? "system",
        at: l.createdAt.toISOString(),
      }))}
    />
  );
}

export function DashboardSectionsFallback() {
  return <DashboardSkeleton />;
}
