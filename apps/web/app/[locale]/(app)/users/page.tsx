import { getTranslations } from "next-intl/server";
import { prisma } from "@xistance/db";
import { requireUser } from "@/lib/auth";
import { UsersView } from "./users-view";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const t = await getTranslations("users");
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
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      quota: true,
      active: true,
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
      <UsersView users={users as unknown as Parameters<typeof UsersView>[0]["users"]} isAdmin={isAdmin} />
    </div>
  );
}
