"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Activity, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function LoginForm() {
  const t = useTranslations("auth");
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: form.get("email"),
        password: form.get("password"),
      }),
    });
    if (res.ok) {
      toast.success(t("welcomeBack"));
      router.push("/");
    } else {
      const data = await res.json().catch(() => ({}));
      setError(data.error ?? t("invalidCredentials"));
    }
    setLoading(false);
  }

  return (
    <Card className="animate-fade-in-up w-full max-w-sm">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/25 transition-transform duration-300 hover:scale-105">
          <Activity className="h-6 w-6" />
        </div>
        <CardTitle>{t("welcomeBack")}</CardTitle>
        <CardDescription>{t("signInSubtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="animate-fade-in-up space-y-2" style={{ "--stagger": 1 } as React.CSSProperties}>
            <Label htmlFor="email">{t("email")}</Label>
            <Input id="email" name="email" type="email" required autoComplete="email" />
          </div>
          <div className="animate-fade-in-up space-y-2" style={{ "--stagger": 2 } as React.CSSProperties}>
            <Label htmlFor="password">{t("password")}</Label>
            <Input id="password" name="password" type="password" required autoComplete="current-password" />
          </div>
          {error && (
            <p role="alert" className="animate-scale-in text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("signIn")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
