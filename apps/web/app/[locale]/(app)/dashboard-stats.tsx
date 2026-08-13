"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import {
  Activity,
  ArrowRightLeft,
  Gauge,
  Network,
  TrendingDown,
  TrendingUp,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import dynamic from "next/dynamic";
import { StatusBadge } from "@/components/status-badge";

// recharts is ~90KB (client-side); load it lazily so it doesn't block the first
// paint of the dashboard, and skip SSR rendering of the chart entirely.
const TrafficChart = dynamic(
  () => import("@/components/traffic-chart").then((m) => m.TrafficChart),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    ),
  },
);

export interface DashboardTunnel {
  id: string;
  name: string;
  method: string;
  status: string;
  port: number | null;
  clientNode: string;
  serverNode: string;
}

interface Props {
  totalTunnels: number;
  activeTunnels: number;
  totalNodes: number;
  onlineNodes: number;
  portForwards: number;
  tunnels: DashboardTunnel[];
  samples: Array<{ ts: string; bytesIn: number; bytesOut: number }>;
  recentActivity: Array<{ action: string; target: string; actor: string; at: string }>;
}

export function DashboardStats(props: Props) {
  const t = useTranslations("dashboard");
  const tStatus = useTranslations("status");
  const router = useRouter();

  const totalIn = props.samples.reduce((a, s) => a + s.bytesIn, 0);
  const totalOut = props.samples.reduce((a, s) => a + s.bytesOut, 0);

  const cards = [
    { label: t("totalTunnels"), value: props.totalTunnels, icon: Network },
    { label: t("activeTunnels"), value: props.activeTunnels, icon: Activity },
    { label: t("totalNodes"), value: `${props.onlineNodes}/${props.totalNodes}`, icon: Gauge },
    { label: t("portForwards"), value: props.portForwards, icon: ArrowRightLeft },
  ];

  function start(tunnelId: string) {
    void (async () => {
      const res = await fetch(`/api/tunnels/${tunnelId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf() },
        body: JSON.stringify({ action: "start" }),
      });
      if (res.ok) {
        toast.success(tStatus("running"));
        router.refresh();
      }
    })();
  }

  function csrf(): string {
    const m = /xt_csrf=([^;]+)/.exec(document.cookie);
    return m ? m[1] : "";
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="flex items-center gap-4 p-5">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <c.icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{c.label}</p>
                <p className="text-2xl font-bold">{c.value}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("trafficToday")}</CardTitle>
            <CardDescription className="flex items-center gap-4">
              <span className="flex items-center gap-1">
                <TrendingDown className="h-4 w-4 text-primary" />
                {formatBytes(totalIn)}
              </span>
              <span className="flex items-center gap-1">
                <TrendingUp className="h-4 w-4 text-success" />
                {formatBytes(totalOut)}
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TrafficChart data={props.samples} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("recentActivity")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {props.recentActivity.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("empty")}</p>
            )}
            {props.recentActivity.map((a, i) => (
              <div key={i} className="flex items-center justify-between text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{a.action}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {a.actor} · {a.target}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {timeAgo(a.at)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("overview")}</CardTitle>
          <CardDescription>
            {props.tunnels.length === 0 ? t("empty") : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {props.tunnels.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <Wifi className="h-10 w-10 text-muted-foreground/50" />
              <Button onClick={() => router.push("/tunnels/new")}>
                {t("quickStart")}
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("name")}</TableHead>
                  <TableHead>{t("method")}</TableHead>
                  <TableHead>{t("nodes")}</TableHead>
                  <TableHead>{t("port")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {props.tunnels.map((x) => (
                  <TableRow key={x.id}>
                    <TableCell className="font-medium">{x.name}</TableCell>
                    <TableCell>{x.method}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {x.clientNode} → {x.serverNode}
                    </TableCell>
                    <TableCell>{x.port ?? "—"}</TableCell>
                    <TableCell>
                      <StatusBadge status={x.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => start(x.id)}>
                        {x.status === "running" ? tStatus("running") : tStatus("stopped")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h`;
}
