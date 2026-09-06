"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Play, Radar, Server, Globe, Activity, ShieldCheck } from "lucide-react";
import { apiFetch } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type ToolType = "tcp" | "http" | "latency" | "dns" | "censorship";

interface ToolResult {
  tcp?: { ok: boolean; ms: number; host: string; port: number };
  http?: { status: number; ms: number; ok: boolean };
  latency?: { avgMs: number | null; reachable: boolean };
  dns?: { ips: string[]; available: boolean };
  censorship?: {
    hosts: Array<{ host: string; port: number; ok: boolean; ms: number }>;
    likelyCensored: boolean;
    blockedCount: number;
  };
}

export function ToolsView() {
  const t = useTranslations("tools");
  const tCommon = useTranslations("common");
  const [active, setActive] = React.useState<ToolType>("tcp");
  const [host, setHost] = React.useState("");
  const [port, setPort] = React.useState(443);
  const [url, setUrl] = React.useState("");
  const [running, setRunning] = React.useState(false);
  const [result, setResult] = React.useState<ToolResult | null>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    let body: unknown;
    if (active === "tcp") body = { type: "tcp", host, port };
    else if (active === "http") body = { type: "http", url };
    else if (active === "latency") body = { type: "latency", host };
    else if (active === "dns") body = { type: "dns" };
    else body = { type: "censorship" };

    try {
      const res = await apiFetch<{ ok: boolean; result: ToolResult; error?: string }>("/api/tools", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setResult(res.data.result);
      } else {
        toast.error(res.data.error ? `${tCommon("error")}: ${res.data.error}` : tCommon("error"));
      }
    } catch {
      toast.error(tCommon("networkError"));
    } finally {
      setRunning(false);
    }
  }

  const tools: Array<{ id: ToolType; label: string; icon: React.ReactNode }> = [
    { id: "tcp", label: t("tcpCheck"), icon: <Server className="h-4 w-4" /> },
    { id: "latency", label: t("latency"), icon: <Activity className="h-4 w-4" /> },
    { id: "http", label: t("httpCheck"), icon: <Globe className="h-4 w-4" /> },
    { id: "dns", label: t("dnsLeak"), icon: <Radar className="h-4 w-4" /> },
    { id: "censorship", label: t("censorship"), icon: <ShieldCheck className="h-4 w-4" /> },
  ];

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-2">
        {tools.map((tool, i) => (
          <button
            key={tool.id}
            type="button"
            onClick={() => {
              setActive(tool.id);
              setResult(null);
            }}
            className={`animate-fade-in-up group flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
              active === tool.id
                ? "border-primary bg-primary/5 shadow-sm"
                : "hover:border-primary/50"
            }`}
            style={{ "--stagger": i } as React.CSSProperties}
          >
            <span className={`transition-transform duration-200 group-hover:scale-110 ${active === tool.id ? "text-primary" : ""}`}>
              {tool.icon}
            </span>
            <span className="text-sm font-medium">{tool.label}</span>
          </button>
        ))}
      </div>

      <Card interactive className="animate-fade-in-up lg:col-span-2" style={{ "--stagger": 2 } as React.CSSProperties}>
        <div className="space-y-4 p-6">
          {(active === "tcp" || active === "latency") && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("host")}</Label>
                <Input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="203.0.113.10"
                />
              </div>
              {active === "tcp" && (
                <div className="space-y-1.5">
                  <Label>{t("port")}</Label>
                  <Input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value))}
                  />
                </div>
              )}
            </div>
          )}
          {active === "http" && (
            <div className="space-y-1.5">
              <Label>{t("url")}</Label>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
              />
            </div>
          )}
          {active === "censorship" && (
            <p className="text-sm text-muted-foreground">{t("runningLocalNode")}</p>
          )}

          <Button onClick={run} disabled={running}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? t("running") : t("run")}
          </Button>

          {result && (
            <div className="animate-fade-in-up space-y-3">
              <div className="text-sm font-medium">{t("result")}</div>
              {result.tcp && (
                <Badge variant={result.tcp.ok ? "success" : "destructive"}>
                  {result.tcp.ok
                    ? t("tcpOpen", { port: result.tcp.port, host: result.tcp.host })
                    : t("tcpClosed", { port: result.tcp.port, host: result.tcp.host })}{" "}
                  · {result.tcp.ms}ms
                </Badge>
              )}
              {result.latency && (
                <div className="text-sm">
                  {result.latency.reachable
                    ? t("latencyResult", { ms: result.latency.avgMs ?? 0 })
                    : "—"}
                </div>
              )}
              {result.http && (
                <Badge variant={result.http.ok ? "success" : "destructive"}>
                  {result.http.ok
                    ? t("httpOk", { code: result.http.status, ms: result.http.ms })
                    : t("httpFail")}{" "}
                  · {result.http.status} · {result.http.ms}ms
                </Badge>
              )}
              {result.dns && (
                <div className="text-sm">
                  {result.dns.available
                    ? t("dnsOk")
                    : t("dnsLeakDetected", { ips: result.dns.ips.join(" · ") })}
                  {result.dns.ips.length > 0 && (
                    <div className="mt-1 font-mono text-xs text-muted-foreground">
                      {result.dns.ips.join(" · ")}
                    </div>
                  )}
                </div>
              )}
              {result.censorship && (
                <div className="space-y-2">
                  <Badge variant={result.censorship.likelyCensored ? "destructive" : "success"}>
                    {result.censorship.likelyCensored ? t("censorshipLikely") : t("censorshipClean")}
                  </Badge>
                  <div className="grid gap-1 sm:grid-cols-2">
                    {result.censorship.hosts.map((h, i) => (
                      <div
                        key={h.host + h.port}
                        className="animate-fade-in-up flex items-center justify-between rounded border px-3 py-1.5 text-xs transition-colors hover:bg-muted/50"
                        style={{ "--stagger": i } as React.CSSProperties}
                      >
                        <span className="font-mono">{h.host}</span>
                        <Badge variant={h.ok ? "success" : "destructive"} className="ml-2">
                          {h.ok ? `${h.ms}ms` : "✕"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
