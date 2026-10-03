"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "muted" | "default"> = {
  running: "success",
  online: "success",
  starting: "warning",
  degraded: "warning",
  stopping: "warning",
  stopped: "muted",
  offline: "muted",
  error: "destructive",
  needs_node: "warning",
  pending: "warning",
  unknown: "muted",
};

/**
 * Every key the `status` catalog provides.
 *
 * Derived from STATUS_VARIANT so the guard and the variant map cannot drift
 * apart: adding a variant without a catalog entry (or the reverse) shows up as
 * a missing key rather than as a runtime throw.
 */
const KNOWN_STATUSES = Object.keys(STATUS_VARIANT);

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const t = useTranslations("status");
  // A state with no catalog entry must degrade to readable text, never throw.
  // next-intl's t() raises an error for a missing key (and renders the error
  // boundary), so `t(status) ?? status` never actually fell back: an engine
  // state outside the catalog -- "unreachable", "probe_failed" -- took the whole
  // row down instead of showing the token.
  const key = KNOWN_STATUSES.includes(status) ? status : "unknown";
  return (
    <Badge
      variant={STATUS_VARIANT[status] ?? "muted"}
      data-status={status}
      className={cn(className)}
    >
      {/* The dot is a redundant visual cue; the text beside it is the signal.
          Hiding it stops a screen reader announcing two empty spans. */}
      <span aria-hidden="true" className="relative flex h-1.5 w-1.5">
        {status === "running" || status === "online" ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
        ) : null}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {/* A recognised state gets its own label; an unrecognised one is labelled
          "unknown" AND names the raw token, so an operator can report the exact
          value instead of seeing a bare word. */}
      {t(key)}
      {key !== status ? (
        <span className="ms-1 font-mono text-[0.7em] opacity-80" data-unmapped-status>
          {status}
        </span>
      ) : null}
    </Badge>
  );
}
