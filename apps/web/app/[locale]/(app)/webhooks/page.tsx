import { getTranslations } from "next-intl/server";
import { prisma } from "@xistance/db";
import { requireUser } from "@/lib/auth";
import { WebhooksView } from "./webhooks-view";

export const dynamic = "force-dynamic";

export default async function WebhooksPage() {
  const t = await getTranslations("webhooks");
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN" || user.role === "SUPER_ADMIN";

  if (!isAdmin) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("forbidden")}</p>
      </div>
    );
  }

  const webhooks = await prisma.notificationWebhook.findMany({
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <WebhooksView
        initialWebhooks={webhooks as unknown as Parameters<typeof WebhooksView>[0]["initialWebhooks"]}
      />
    </div>
  );
}
