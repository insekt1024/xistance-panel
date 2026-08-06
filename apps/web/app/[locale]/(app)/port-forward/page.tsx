import { getTranslations } from "next-intl/server";
import { prisma } from "@xistance/db";
import { PortForwardView } from "./port-forward-view";

export const dynamic = "force-dynamic";

export default async function PortForwardPage() {
  const t = await getTranslations("portForward");
  const rules = await prisma.portForward.findMany({
    orderBy: { createdAt: "desc" },
  });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <PortForwardView rules={rules as unknown as Parameters<typeof PortForwardView>[0]["rules"]} />
    </div>
  );
}
