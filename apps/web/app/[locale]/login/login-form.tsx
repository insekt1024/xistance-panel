"use client";

import * as React from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function LoginForm() {
  const t = useTranslations("auth");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Arriving here with an expired access token but a still-valid refresh
  // cookie is the common case after an idle period — the server render cannot
  // set cookies, so it redirects here. Renew silently and go back rather than
  // asking for a password the user did not need to re-enter.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const m = /xt_csrf=([^;]+)/.exec(document.cookie);
      if (!m) return; // never logged in on this browser
      try {
        const res = await fetch("/api/auth/refresh", {
          method: "POST",
          headers: { "X-CSRF-Token": m[1] },
        });
        if (!cancelled && res.ok) router.replace("/");
      } catch {
        // Offline: fall through to the normal login form.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const form = new FormData(e.currentTarget);
      // apiFetch: 30s timeout so slow/reset networks cannot hang the button,
      // and a thrown network error lands in the catch below (loading always
      // clears in finally). CSRF header is attached automatically.
      const res = await apiFetch<{ error?: string }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: form.get("email"),
          password: form.get("password"),
        }),
      });
      if (res.ok) {
        toast.success(t("welcomeBack"));
        router.push("/");
      } else {
        setError(res.data?.error ?? t("invalidCredentials"));
      }
    } catch {
      setError(tCommon("networkError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="animate-fade-in-up w-full max-w-sm">
      <CardHeader className="text-center">
        <div className="mx-auto mb-2 transition-transform duration-300 hover:scale-105">
          <Image
            src="/xistance-logo.svg"
            alt="Xistance Panel logo"
            className="h-11 w-11 rounded-xl shadow-lg"
            width={44}
            height={44}
          />
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
