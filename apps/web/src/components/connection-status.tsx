"use client";

import { useHealthCheck } from "@/hooks/use-health-check";
import { cn } from "@/lib/utils";

export function ConnectionStatus() {
  const { isHealthy, lastChecked } = useHealthCheck({ interval: 30000 });

  return (
    <div
      className="group relative flex items-center"
      title={
        lastChecked
          ? `${isHealthy ? "Connected" : "Disconnected"} — checked ${lastChecked.toLocaleTimeString()}`
          : "Checking connection…"
      }
    >
      <span
        className={cn(
          "relative flex h-2 w-2 rounded-full transition-colors",
          isHealthy ? "bg-emerald-500" : "bg-red-500",
        )}
      >
        {isHealthy && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        )}
      </span>

      <span className="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md opacity-0 transition-opacity group-hover:opacity-100">
        {isHealthy ? "Connected" : "Disconnected"}
      </span>
    </div>
  );
}
