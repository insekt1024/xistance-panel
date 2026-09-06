import { getTranslations } from "next-intl/server";
import { prisma } from "@xistance/db";
import { getEngine } from "@/lib/engine";
import { AutoRefresh } from "@/components/auto-refresh";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/routing";
import { Plus } from "lucide-react";
import { TunnelTable } from "./tunnel-table";
import { ImportDialogLazy as ImportDialog } from "./import-dialog-lazy";

export const dynamic = "force-dynamic";

export default async function TunnelsPage() {
  const t = await getTranslations("tunnels");
  const [tunnels, nodes] = await Promise.all([
    prisma.tunnel.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, method: true, status: true, state: true,
        port: true, autostart: true, createdAt: true,
        clientNode: { select: { name: true } },
        serverNode: { select: { name: true } },
      },
    }),
    prisma.node.findMany({
      select: { id: true, name: true, type: true },
      orderBy: { name: "asc" },
    }),
  ]);
  const engine = getEngine();
  const rows = await Promise.all(
    tunnels.map(async (tun) => {
      const live = engine.has(tun.id) ? await engine.status(tun.id) : tun.state;
      const snap = engine.has(tun.id) ? await engine.snapshot(tun.id) : null;
      return {
        id: tun.id,
        name: tun.name,
        method: tun.method,
        state: live,
        port: tun.port,
        clientNode: tun.clientNode?.name ?? "—",
        serverNode: tun.serverNode?.name ?? "—",
        autostart: tun.autostart,
        bytesIn: snap?.bytesIn ?? 0,
        bytesOut: snap?.bytesOut ?? 0,
        createdAt: tun.createdAt.toISOString(),
      };
    }),
  );

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
          <p className="text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <ImportDialog nodes={nodes} />
          <Button asChild>
            <Link href="/tunnels/new">
              <Plus className="h-4 w-4" />
              {t("new")}
            </Link>
          </Button>
        </div>
      </div>
      <TunnelTable tunnels={rows} />
    </div>
  );
}
