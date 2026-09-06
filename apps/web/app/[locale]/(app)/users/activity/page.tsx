import { getTranslations } from "next-intl/server";
import { prisma } from "@xistance/db";
import { requireUser } from "@/lib/auth";
import { UserActivityView } from "./user-activity-view";

export const dynamic = "force-dynamic";

const LIST_LIMIT = 50;

export default async function UserActivityPage() {
  const t = await getTranslations("userActivity");
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

  const [logs, actionTypes, users] = await Promise.all([
    prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: LIST_LIMIT,
      select: {
        id: true,
        actorId: true,
        action: true,
        target: true,
        details: true,
        ip: true,
        createdAt: true,
        actor: { select: { id: true, name: true, email: true } },
      },
    }),
    prisma.auditLog.findMany({
      select: { action: true },
      distinct: ["action"],
      orderBy: { action: "asc" },
    }),
    prisma.user.findMany({
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    }),
  ]);

  const hasNext = logs.length === LIST_LIMIT;
  const nextCursor = hasNext ? logs[logs.length - 1].id : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <UserActivityView
        initialLogs={logs as unknown as Parameters<typeof UserActivityView>[0]["initialLogs"]}
        initialHasNext={hasNext}
        initialNextCursor={nextCursor}
        initialActionTypes={actionTypes.map((a) => a.action)}
        users={users}
      />
    </div>
  );
}
