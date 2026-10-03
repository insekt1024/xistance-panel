"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
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

function ChartLoading() {
  const tCommon = useTranslations("common");
  return (
    <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
      {tCommon("loading")}
    </div>
  );
}

// recharts is ~90KB (client-side); load it lazily so it doesn't block the first
// paint of the dashboard, and skip SSR rendering of the chart entirely.
const TrafficChart = dynamic(
  () => import("@/components/traffic-chart").then((m) => m.TrafficChart),
  {
    ssr: false,
    loading: () => <ChartLoading />,
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
  /** The server's clock at render time, so relative times hydrate identically. */
  nowMs: number;
}

export interface StatCardsProps {
  totalTunnels: number;
  activeTunnels: number;
  totalNodes: number;
  onlineNodes: number;
  portForwards: number;
}

export function StatCards(props: StatCardsProps) {
  const t = useTranslations("dashboard");

  const cards = [
    { label: t("totalTunnels"), value: props.totalTunnels, icon: Network },
    { label: t("activeTunnels"), value: props.activeTunnels, icon: Activity },
    { label: t("totalNodes"), value: `${props.onlineNodes}/${props.totalNodes}`, icon: Gauge },
    { label: t("portForwards"), value: props.portForwards, icon: ArrowRightLeft },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((c, i) => (
        <Card key={c.label} interactive className="animate-fade-in-up" style={{ "--stagger": i } as React.CSSProperties}>
          <CardContent className="flex items-center gap-4 p-5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 transition-colors duration-200 group-hover:bg-primary/15">
              <c.icon className="h-5 w-5 text-primary" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{c.label}</p>
              <p className="text-2xl font-bold tabular-nums tracking-tight">{c.value}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function TrafficPanel(props: {
  samples: Array<{ ts: string; bytesIn: number; bytesOut: number }>;
}) {
  const t = useTranslations("dashboard");

  const totalIn = props.samples.reduce((a, s) => a + s.bytesIn, 0);
  const totalOut = props.samples.reduce((a, s) => a + s.bytesOut, 0);

  return (
    <Card interactive className="animate-fade-in-up lg:col-span-2" style={{ "--stagger": 4 } as React.CSSProperties}>
      <CardHeader>
        <CardTitle>{t("traffic")}</CardTitle>
        {/* `flex-wrap` so a byte figure that does not fit MOVES TO THE NEXT LINE
            instead of wrapping inside its own 20px-tall box. Measured at 40-42px
            wide: "0 B" broke after the space and needed two lines in a box that
            allowed one, in BOTH locales and at every width down to 320px. The
            icons are `shrink-0` so they never compress either, and each figure is
            `whitespace-nowrap` so a value is never split across lines.
            Found by test-dashboard-legibility.ts. */}
        <CardDescription className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
            <TrendingDown className="h-4 w-4 shrink-0 text-primary" />
            {formatBytes(totalIn)}
          </span>
          <span className="flex shrink-0 items-center gap-1 whitespace-nowrap">
            <TrendingUp className="h-4 w-4 shrink-0 text-success" />
            {formatBytes(totalOut)}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <TrafficChart key={props.samples.length} data={props.samples} />
      </CardContent>
    </Card>
  );
}

export function ActivityPanel(props: {
  recentActivity: Array<{ action: string; target: string; actor: string; at: string }>;
  /** The server's clock, so the first client render formats the same number. */
  nowMs: number;
}) {
  const t = useTranslations("dashboard");
  const locale = useLocale();
  const labels = useElapsedLabels(props.recentActivity, locale, props.nowMs);

  return (
    <Card interactive className="animate-fade-in-up" style={{ "--stagger": 5 } as React.CSSProperties}>
      <CardHeader>
        <CardTitle>{t("recentActivity")}</CardTitle>
      </CardHeader>
      {/* Stable hook: the smoke suite must be able to find this panel without
          inferring it from a class or a translated string, both of which have
          changed and silently emptied the assertion before. */}
      <CardContent className="space-y-3" data-testid="activity-panel">
        {props.recentActivity.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        )}
        {props.recentActivity.map((a, i) => (
          <div
            key={i}
            className="animate-fade-in-up flex items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-muted/50"
            style={{ "--stagger": i } as React.CSSProperties}
          >
            {/* `min-w-0` lets `truncate` engage: a flex item's default
                `min-width:auto` refuses to shrink below its content, so the
                ellipsis never applied. Mutation-tested: reverting `min-w-0`
                here leaves this suite GREEN, so it is NOT load-bearing on its
                own -- the parent no longer needs the help. Kept because it is
                correct in principle and harmless, and because the comment
                records that the change was tested rather than assumed.
                Found by test-dashboard-legibility.ts. */}
            <div className="min-w-0">
              <p className="truncate font-medium">{a.action}</p>
              <p className="truncate text-xs text-muted-foreground">
                {a.actor} · {a.target}
              </p>
            </div>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {labels[i]}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function TunnelsTable(props: { tunnels: DashboardTunnel[] }) {
  const t = useTranslations("dashboard");
  const tCommon = useTranslations("common");
  const tStatus = useTranslations("status");
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);

  async function runAction(tunnelId: string, action: "start" | "stop") {
    setBusyId(tunnelId);
    try {
      const res = await fetch(`/api/tunnels/${tunnelId}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf() },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        toast.success(action === "start" ? tStatus("running") : tStatus("stopped"));
        router.refresh();
      } else {
        let message: string | undefined;
        try {
          const body = (await res.json()) as { error?: string; message?: string };
          message = body?.error ?? body?.message;
        } catch {
          /* non-JSON error body */
        }
        toast.error(message || tCommon("error"));
      }
    } catch {
      toast.error(tCommon("networkError"));
    } finally {
      setBusyId(null);
    }
  }

  function csrf(): string {
    const m = /xt_csrf=([^;]+)/.exec(document.cookie);
    return m ? m[1] : "";
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("overview")}</CardTitle>
        <CardDescription>
          {props.tunnels.length === 0 ? t("empty") : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {props.tunnels.length === 0 ? (
          <div className="animate-fade-in flex flex-col items-center gap-3 py-10 text-center">
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
                <TableRow key={x.id} className="animate-fade-in">
                  <TableCell className="font-medium">{x.name}</TableCell>
                  <TableCell>{x.method}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {x.clientNode} → {x.serverNode}
                  </TableCell>
                  <TableCell className="tabular-nums">{x.port ?? "—"}</TableCell>
                  <TableCell>
                    <StatusBadge status={x.status} />
                  </TableCell>
                  <TableCell className="text-left rtl:text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === x.id}
                      onClick={() => runAction(x.id, x.status === "running" ? "stop" : "start")}
                    >
                      {x.status === "running" ? tCommon("stop") : tCommon("start")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function DashboardStats(props: Props) {
  return (
    <div className="animate-fade-in space-y-6">
      <StatCards
        totalTunnels={props.totalTunnels}
        activeTunnels={props.activeTunnels}
        totalNodes={props.totalNodes}
        onlineNodes={props.onlineNodes}
        portForwards={props.portForwards}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <TrafficPanel samples={props.samples} />
        <ActivityPanel recentActivity={props.recentActivity} nowMs={props.nowMs} />
      </div>

      <TunnelsTable tunnels={props.tunnels} />
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatElapsed(secs: number, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
  if (secs < 60) return rtf.format(-secs, "second");
  if (secs < 3600) return rtf.format(-Math.floor(secs / 60), "minute");
  if (secs < 86400) return rtf.format(-Math.floor(secs / 3600), "hour");
  return rtf.format(-Math.floor(secs / 86400), "day");
}

/**
 * "x minutes ago" computed from `Date.now()` inside render is a hydration
 * mismatch by construction: the server stamps the string at render time and the
 * client recomputes it a moment later, so any activity old enough to sit near a
 * unit boundary renders two different text nodes (React error #418).
 *
 * The elapsed value is therefore computed ONCE per activity entry and passed
 * down, so the server and the client format the SAME number. The countdown then
 * refreshes from an effect, after hydration has finished, where re-rendering is
 * legal and correct.
 */
function useElapsedLabels(entries: Array<{ at: string }>, locale: string, nowMs: number): string[] {
  // A lazy initialiser is NOT a fix: React runs it on the server during SSR and
  // again on the client during hydration, so both sides still call Date.now()
  // and still disagree. The first render must be a pure function of props, so it
  // is seeded from the server's own clock -- passed in as a prop, therefore
  // identical on both sides. Only the effect re-reads the real clock, and that
  // runs after hydration has finished.
  const [labels, setLabels] = React.useState<string[]>(() =>
    entries.map((e) => formatElapsed(Math.max(0, Math.floor((nowMs - new Date(e.at).getTime()) / 1000)), locale)),
  );
  React.useEffect(() => {
    const tick = () =>
      setLabels(
        entries.map((e) =>
          formatElapsed(Math.max(0, Math.floor((Date.now() - new Date(e.at).getTime()) / 1000)), locale),
        ),
      );
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [entries, locale]);
  return labels;
}
