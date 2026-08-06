import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/auth";
import { SettingsView } from "./settings-view";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const t = await getTranslations("settings");
  const user = await requireUser();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <SettingsView isAdmin={user.role === "ADMIN" || user.role === "SUPER_ADMIN"} />
    </div>
  );
}
