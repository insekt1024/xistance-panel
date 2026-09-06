"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowDown, ArrowUp, Clock, Gauge } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Range = "1h" | "6h" | "24h" | "7d";
type ChartType = "area" | "line";

const RANGES: { key: Range; label: string }[] = [
  { key: "1h", label: "1h" },
  { key: "6h", label: "6h" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
}

function getRangeMs(range: Range): number {
  const HOUR = 3600_000;
  return { "1h": HOUR, "6h": 6 * HOUR, "24h": 24 * HOUR, "7d": 7 * 24 * HOUR }[range];
}

export function TrafficChart({
  data: initialData,
}: {
  data: Array<{ ts: string; bytesIn: number; bytesOut: number }>;
}) {
  const t = useTranslations("dashboard");
  const [range, setRange] = React.useState<Range>("24h");
  const [chartType, setChartType] = React.useState<ChartType>("area");
  const [data, setData] = React.useState(initialData);
  const [loading, setLoading] = React.useState(false);

  const fetchRange = React.useCallback(async (r: Range) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/traffic?range=${r}`);
      if (res.ok) {
        const json = await res.json();
        if (json.ok) setData(json.data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRangeChange = React.useCallback(
    (r: Range) => {
      setRange(r);
      void fetchRange(r);
    },
    [fetchRange],
  );

  // Summary stats
  const rangeMs = getRangeMs(range);
  const totalIn = data.reduce((a, s) => a + s.bytesIn, 0);
  const totalOut = data.reduce((a, s) => a + s.bytesOut, 0);
  const avgSpeedIn = rangeMs > 0 ? totalIn / (rangeMs / 1000) : 0;
  const avgSpeedOut = rangeMs > 0 ? totalOut / (rangeMs / 1000) : 0;

  if (data.length === 0 && !loading) {
    return (
      <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
        No traffic yet
      </div>
    );
  }

  const points = data.map((d) => ({
    name: new Date(d.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    down: +(d.bytesIn / 1024).toFixed(1),
    up: +(d.bytesOut / 1024).toFixed(1),
  }));

  const tooltipFormatter = (value: unknown, name: unknown) =>
    [`${Number(value).toLocaleString()} KB`, name === "down" ? "↓ Down" : "↑ Up"] as [
      string,
      string,
    ];

  const tooltipStyle = {
    background: "var(--color-popover)",
    border: "1px solid var(--color-border)",
    borderRadius: 10,
    fontSize: 12,
    boxShadow: "0 8px 24px -8px oklch(0 0 0 / 0.25)",
    padding: "6px 10px",
  };

  const sharedAxisProps = {
    tick: { fontSize: 11 },
    stroke: "var(--color-muted-foreground)",
  };

  return (
    <div className={cn("space-y-3", loading && "opacity-60 pointer-events-none")}>
      {/* Controls row */}
      <div className="flex items-center justify-between gap-2">
        {/* Time range selector */}
        <div className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5 text-muted-foreground mr-1" />
          {RANGES.map((r) => (
            <Button
              key={r.key}
              variant={range === r.key ? "default" : "ghost"}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => handleRangeChange(r.key)}
            >
              {r.label}
            </Button>
          ))}
        </div>

        {/* Chart type toggle */}
        <div className="flex items-center rounded-lg bg-muted p-0.5">
          <button
            onClick={() => setChartType("area")}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-all",
              chartType === "area"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Area
          </button>
          <button
            onClick={() => setChartType("line")}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-all",
              chartType === "line"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Line
          </button>
        </div>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={224}>
        {chartType === "area" ? (
          <AreaChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
            <defs>
              <linearGradient id="gDown" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.3} />
                <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gUp" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--color-success)" stopOpacity={0.3} />
                <stop offset="100%" stopColor="var(--color-success)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis dataKey="name" {...sharedAxisProps} minTickGap={40} />
            <YAxis {...sharedAxisProps} tickFormatter={(v: number) => `${v}K`} />
            <Tooltip formatter={tooltipFormatter} contentStyle={tooltipStyle} cursor={{ stroke: "var(--color-muted-foreground)", strokeOpacity: 0.3 }} animationDuration={150} />
            <Area type="monotone" dataKey="down" stroke="var(--color-primary)" strokeWidth={2} fill="url(#gDown)" animationDuration={700} animationEasing="ease-out" activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--color-background)" }} />
            <Area type="monotone" dataKey="up" stroke="var(--color-success)" strokeWidth={2} fill="url(#gUp)" animationDuration={900} animationEasing="ease-out" activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--color-background)" }} />
          </AreaChart>
        ) : (
          <LineChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis dataKey="name" {...sharedAxisProps} minTickGap={40} />
            <YAxis {...sharedAxisProps} tickFormatter={(v: number) => `${v}K`} />
            <Tooltip formatter={tooltipFormatter} contentStyle={tooltipStyle} cursor={{ stroke: "var(--color-muted-foreground)", strokeOpacity: 0.3 }} animationDuration={150} />
            <Line type="monotone" dataKey="down" stroke="var(--color-primary)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--color-background)" }} animationDuration={700} animationEasing="ease-out" />
            <Line type="monotone" dataKey="up" stroke="var(--color-success)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--color-background)" }} animationDuration={900} animationEasing="ease-out" />
          </LineChart>
        )}
      </ResponsiveContainer>

      {/* Summary stats row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
          <ArrowDown className="h-3.5 w-3.5 text-primary" />
          <div>
            <p className="text-[10px] text-muted-foreground">{t("download")}</p>
            <p className="text-sm font-semibold tabular-nums">{formatBytes(totalIn)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
          <ArrowUp className="h-3.5 w-3.5 text-success" />
          <div>
            <p className="text-[10px] text-muted-foreground">{t("upload")}</p>
            <p className="text-sm font-semibold tabular-nums">{formatBytes(totalOut)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
          <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
          <div>
            <p className="text-[10px] text-muted-foreground">↓ {t("speedIn")}</p>
            <p className="text-sm font-semibold tabular-nums">{formatSpeed(avgSpeedIn)}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
          <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
          <div>
            <p className="text-[10px] text-muted-foreground">↑ {t("speedOut")}</p>
            <p className="text-sm font-semibold tabular-nums">{formatSpeed(avgSpeedOut)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
