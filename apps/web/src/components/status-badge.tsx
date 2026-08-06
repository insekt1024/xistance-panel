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

export function StatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const t = useTranslations("status");
  return (
    <Badge variant={STATUS_VARIANT[status] ?? "muted"} className={cn(className)}>
      <span className="relative flex h-1.5 w-1.5">
        {status === "running" || status === "online" ? (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
        ) : null}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
      </span>
      {t(status as keyof typeof t) ?? status}
    </Badge>
  );
}
