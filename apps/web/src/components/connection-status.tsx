"use client";

import { useTranslations } from "next-intl";
import { useHealthCheck } from "@/hooks/use-health-check";
import { cn } from "@/lib/utils";

export function ConnectionStatus() {
  const t = useTranslations("common");
  const { isHealthy, lastChecked, error } = useHealthCheck({ interval: 30000 });

  return (
    <div
      className="group relative flex items-center"
      title={
        lastChecked
          ? `${isHealthy ? t("connected") : t("disconnected")} — ${t("lastChecked", { time: lastChecked.toLocaleTimeString() })}${!isHealthy && error ? ` (${error})` : ""}`
          : t("checkingConnection")
      }
    >
      {/* Colour alone is not a signal (1.4.1) and `title` is not reliably
          exposed to assistive technology, so the state is also rendered as
          visually-hidden text. */}
      <span className="sr-only" role="status">
        {lastChecked
          ? isHealthy
            ? t("connected")
            : t("disconnected")
          : t("checkingConnection")}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "relative flex h-2 w-2 rounded-full transition-colors",
          isHealthy ? "bg-emerald-500" : "bg-red-500",
        )}
      >
        {isHealthy && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
        )}
      </span>

      {/* The offset is logical (`me-2`, away from the inline end) so it must be
          paired with a logical anchor too. `right-full` pinned the tooltip to
          the physical right in BOTH directions, so in Persian it was pushed
          out through the wrong edge of the viewport instead of appearing to the
          left of the dot. `end-full` is the logical form of `right-full`. */}
      <span className="pointer-events-none absolute end-full top-1/2 me-2 -translate-y-1/2 whitespace-nowrap rounded-md bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md opacity-0 transition-opacity group-hover:opacity-100">
        {isHealthy ? t("connected") : t("disconnected")}
      </span>
    </div>
  );
}
