"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Card, CardContent, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("dashboard");
  const tCommon = useTranslations("common");

  useEffect(() => {
    console.error("Dashboard error:", error);
  }, [error]);

  return (
    <Card className="animate-fade-in">
      <CardContent className="flex flex-col items-center gap-4 py-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-7 w-7 text-destructive" />
        </div>
        <div className="space-y-1">
          <CardTitle className="text-xl">{t("errorTitle")}</CardTitle>
          <CardDescription>{t("errorMessage")}</CardDescription>
        </div>
        <Button onClick={reset} variant="outline" className="mt-2 gap-2">
          <RefreshCw className="h-4 w-4" />
          {tCommon("retry")}
        </Button>
      </CardContent>
    </Card>
  );
}
