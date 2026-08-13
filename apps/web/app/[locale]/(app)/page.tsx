import { getTranslations } from "next-intl/server";
import { prisma } from "@xistance/db";
import { getEngine } from "@/lib/engine";
import { DashboardStats } from "./dashboard-stats";
import { AutoRefresh } from "@/components/auto-refresh";

export const dynamic = "force-dynamic";

const HOUR_MS = 3600_000;
const CHART_BUCKET_MS = 30 * 60_000;

/**
 * Reduce raw 24h samples into fixed 30-minute buckets so the chart payload is a
 * handful of points instead of ~2880 rows per tunnel. Summing buckets preserves
 * the totals shown on the cards (sum over all buckets == sum over all rows).
 */
function aggregateTraffic(
  rows: Array<{ bytesIn: bigint; bytesOut: bigint; ts: Date }>,
): Array<{ ts: string; bytesIn: number; bytesOut: number }> {
  const buckets = new Map<number, { ts: number; bytesIn: bigint; bytesOut: bigint }>();
  for (const r of rows) {
    const key = Math.floor(r.ts.getTime() / CHART_BUCKET_MS) * CHART_BUCKET_MS;
    const b = buckets.get(key) ?? { ts: key, bytesIn: BigInt(0), bytesOut: BigInt(0) };
    b.bytesIn += r.bytesIn;
    b.bytesOut += r.bytesOut;
    buckets.set(key, b);
  }
  return [...buckets.values()]
    .sort((a, b) => a.ts - b.ts)
    .map((b) => ({
      ts: new Date(b.ts).toISOString(),
      bytesIn: Number(b.bytesIn),
      bytesOut: Number(b.bytesOut),
    }));
}

export default async function DashboardPage() {
  const t = await getTranslations("dashboard");
  const [tunnels, nodes, portForwards, recentLogs] = await Promise.all([
    prisma.tunnel.findMany({
      include: {
        clientNode: { select: { id: true, name: true, type: true } },
        serverNode: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    prisma.node.findMany(),
    prisma.portForward.count(),
    prisma.auditLog.findMany({
      include: { actor: { select: { name: true, email: true } } },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
  ]);

  const engine = getEngine();
  const liveTunnels = await Promise.all(
    tunnels.map(async (tun) => {
      const live = engine.has(tun.id) ? await engine.status(tun.id) : tun.state;
      return { ...tun, liveState: live };
    }),
  );

  const since = new Date(Date.now() - 24 * HOUR_MS); // eslint-disable-line react-hooks/purity
  const rawSamples = await prisma.trafficSample.findMany({
    where: { ts: { gte: since } },
    select: { bytesIn: true, bytesOut: true, ts: true },
    orderBy: { ts: "asc" },
  });
  const samples = aggregateTraffic(rawSamples);

  const running = liveTunnels.filter((x) => x.liveState === "running").length;

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("greeting")} 👋
        </h1>
        <p className="text-muted-foreground">{t("overview")}</p>
      </div>

      <DashboardStats
        totalTunnels={tunnels.length}
        activeTunnels={running}
        totalNodes={nodes.length}
        onlineNodes={nodes.filter((n) => n.status === "online").length}
        portForwards={portForwards}
        tunnels={liveTunnels.map((x) => ({
          id: x.id,
          name: x.name,
          method: x.method,
          status: x.liveState,
          port: x.port,
          clientNode: x.clientNode?.name ?? "—",
          serverNode: x.serverNode?.name ?? "—",
        }))}
        samples={samples}
        recentActivity={recentLogs.map((l) => ({
          action: l.action,
          target: l.target ?? "",
          actor: l.actor?.name ?? "system",
          at: l.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
