"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export function TrafficChart({
  data,
}: {
  data: Array<{ ts: string; bytesIn: number; bytesOut: number }>;
}) {
  if (data.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
        No traffic yet
      </div>
    );
  }
  const points = data.map((d, i) => ({
    name: new Date(d.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    down: +(d.bytesIn / 1024).toFixed(1),
    up: +(d.bytesOut / 1024).toFixed(1),
    idx: i,
  }));

  return (
    <ResponsiveContainer width="100%" height={224}>
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
        <XAxis dataKey="name" tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground)" minTickGap={40} />
        <YAxis tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground)" tickFormatter={(v: number) => `${v}K`} />
        <Tooltip
          formatter={
            ((value: unknown, name: string) =>
              [`${Number(value)} KB`, name === "down" ? "↓ Down" : "↑ Up"]) as never
          }
          contentStyle={{
            background: "var(--color-popover)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            fontSize: 12,
          }}
        />
        <Area type="monotone" dataKey="down" stroke="var(--color-primary)" strokeWidth={2} fill="url(#gDown)" />
        <Area type="monotone" dataKey="up" stroke="var(--color-success)" strokeWidth={2} fill="url(#gUp)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}
