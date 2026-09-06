import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { AutoRefresh } from "@/components/auto-refresh";
import { StatsSection, DashboardSectionsFallback } from "./dashboard-sections";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const t = await getTranslations("dashboard");

  return (
    <div className="space-y-6">
      <AutoRefresh />
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("greeting")} 👋
        </h1>
        <p className="text-muted-foreground">{t("overview")}</p>
      </div>

      <Suspense fallback={<DashboardSectionsFallback />}>
        <StatsSection />
      </Suspense>
    </div>
  );
}
