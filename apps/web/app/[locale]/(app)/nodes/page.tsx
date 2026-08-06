import { getTranslations } from "next-intl/server";
import { prisma } from "@xistance/db";
import { NodesView } from "./nodes-view";

export const dynamic = "force-dynamic";

export default async function NodesPage() {
  const t = await getTranslations("nodes");
  const nodes = await prisma.node.findMany({
    select: {
      id: true,
      name: true,
      type: true,
      host: true,
      sshPort: true,
      sshUser: true,
      authMethod: true,
      status: true,
      sshKeyEncrypted: true,
      sshPasswordEnc: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <NodesView nodes={nodes as unknown as Parameters<typeof NodesView>[0]["nodes"]} />
    </div>
  );
}
