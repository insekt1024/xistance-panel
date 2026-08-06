import { getTranslations } from "next-intl/server";
import { ToolsView } from "./tools-view";

export default async function ToolsPage() {
  const t = await getTranslations("tools");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>
      <ToolsView />
    </div>
  );
}
