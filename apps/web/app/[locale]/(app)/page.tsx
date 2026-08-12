import { getTranslations } from "next-intl/server";
import { prisma } from "@xistance/db";
import { getEngine } from "@/lib/engine";
import { DashboardStats } from "./dashboard-stats";
import { AutoRefresh } from "@/components/auto-refresh";

export const dynamic = "force-dynamic";

const HOUR_MS = 3600_000;

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
  const samples = await prisma.trafficSample.findMany({
    where: { ts: { gte: since } },
    select: { tunnelId: true, bytesIn: true, bytesOut: true, ts: true },
    orderBy: { ts: "asc" },
  });

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
        samples={samples.map((s) => ({
          ts: s.ts.toISOString(),
          bytesIn: Number(s.bytesIn),
          bytesOut: Number(s.bytesOut),
        }))}
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
