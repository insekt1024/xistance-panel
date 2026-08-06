import { getTranslations } from "next-intl/server";
import { prisma } from "@xistance/db";
import { TunnelWizard } from "./tunnel-wizard";

export const dynamic = "force-dynamic";

export default async function NewTunnelPage() {
  const t = await getTranslations("wizard");
  const nodes = await prisma.node.findMany({
    select: { id: true, name: true, type: true, host: true },
    orderBy: { name: "asc" },
  });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <TunnelWizard
        nodes={nodes.map((n) => ({
          id: n.id,
          name: n.name,
          type: n.type as "IRAN" | "FOREIGN",
          host: n.host,
        }))}
      />
    </div>
  );
}
