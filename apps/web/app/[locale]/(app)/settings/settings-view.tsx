"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { toast } from "sonner";
import { Download, ExternalLink, Loader2, Monitor, Moon, RefreshCw, Sun, Upload } from "lucide-react";
import { useTheme } from "next-themes";
import { apiFetch } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function SettingsView({ isAdmin }: { isAdmin: boolean }) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [changing, setChanging] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  async function changePassword() {
    setChanging(true);
    const res = await apiFetch("/api/settings/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    setChanging(false);
    if (res.ok) {
      toast.success(t("passwordChanged"));
      setCurrentPassword("");
      setNewPassword("");
    } else {
      toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
    }
  }

  async function exportBackup() {
    setExporting(true);
    const res = await fetch("/api/settings/backup");
    const data = await res.json();
    setExporting(false);
    if (!res.ok) {
      toast.error((data as { error?: string })?.error ?? tCommon("error"));
      return;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `xistance-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast.success(t("backupExported"));
  }

  async function restoreBackup(file: File) {
    setRestoring(true);
    try {
      const parsed = JSON.parse(await file.text());
      const res = await apiFetch("/api/settings/backup", {
        method: "POST",
        body: JSON.stringify({ backup: parsed.backup ?? parsed }),
      });
      if (res.ok) {
        toast.success(t("backupRestored"));
        router.refresh();
      } else {
        toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
      }
    } catch {
      toast.error(tCommon("error"));
    }
    setRestoring(false);
  }

  return (
    <Tabs defaultValue="security" className="animate-fade-in space-y-6">
      <TabsList>
        <TabsTrigger value="security">{t("security")}</TabsTrigger>
        {isAdmin && <TabsTrigger value="backup">{t("backup")}</TabsTrigger>}
        <TabsTrigger value="general">{t("general")}</TabsTrigger>
      </TabsList>

      <TabsContent value="security" className="animate-scale-in">
        <Card interactive>
          <CardHeader>
            <CardTitle>{t("changePassword")}</CardTitle>
          </CardHeader>
          <CardContent className="max-w-md space-y-4">
            <div className="space-y-1.5">
              <Label>{t("currentPassword")}</Label>
              <Input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("newPassword")}</Label>
              <Input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </div>
            <Button onClick={changePassword} disabled={changing}>
              {changing && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("changePassword")}
            </Button>
          </CardContent>
        </Card>
      </TabsContent>

      {isAdmin && (
        <TabsContent value="backup" className="animate-scale-in">
          <Card interactive>
            <CardHeader>
              <CardTitle>{t("backup")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-3">
                <Button onClick={exportBackup} disabled={exporting}>
                  {exporting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                  {t("exportBackup")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                  disabled={restoring}
                >
                  {restoring ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  {t("importBackup")}
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void restoreBackup(f);
                    e.target.value = "";
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground">{t("backupNote")}</p>
            </CardContent>
          </Card>
        </TabsContent>
      )}

      <TabsContent value="general" className="animate-scale-in">
        <Card interactive>
          <CardHeader>
            <CardTitle>{t("general")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-1.5">
              <Label>{t("theme")}</Label>
              <Select value={theme ?? "system"} onValueChange={setTheme}>
                <SelectTrigger className="w-full max-w-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">
                    <span className="flex items-center gap-2">
                      <Sun className="h-4 w-4" />
                      {t("themeLight")}
                    </span>
                  </SelectItem>
                  <SelectItem value="dark">
                    <span className="flex items-center gap-2">
                      <Moon className="h-4 w-4" />
                      {t("themeDark")}
                    </span>
                  </SelectItem>
                  <SelectItem value="system">
                    <span className="flex items-center gap-2">
                      <Monitor className="h-4 w-4" />
                      {t("themeSystem")}
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("apiDocs")}</Label>
              <p className="text-sm text-muted-foreground">{t("apiDocsDescription")}</p>
              <Button variant="outline" asChild>
                <a href="/api/docs" target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  {t("apiDocs")}
                </a>
              </Button>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t("selfUpdate")}</p>
              <div className="mt-3 flex items-center gap-3">
                <Button variant="outline" onClick={() => toast.success(t("upToDate"))}>
                  <RefreshCw className="h-4 w-4" />
                  {t("updateNow")}
                </Button>
                <span className="text-sm text-muted-foreground">{t("upToDate")}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
