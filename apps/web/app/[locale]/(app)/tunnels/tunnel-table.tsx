"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import {
  Download,
  Loader2,
  MoreHorizontal,
  Network,
  Play,
  RotateCw,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/client";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ResponsiveTable,
  TableBodyWrapper,
  TableRowWrapper,
} from "@/components/ui/responsive-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import dynamic from "next/dynamic";

const LogViewer = dynamic(
  () => import("./log-viewer").then((m) => ({ default: m.LogViewer })),
  {
    ssr: false,
    loading: () => (
      <div className="h-64 animate-pulse bg-muted rounded" />
    ),
  },
);

export interface TunnelRow {
  id: string;
  name: string;
  method: string;
  state: string;
  port: number | null;
  clientNode: string;
  serverNode: string;
  autostart: boolean;
  bytesIn: number;
  bytesOut: number;
  createdAt: string;
}

export function TunnelTable({ tunnels }: { tunnels: TunnelRow[] }) {
  const t = useTranslations("tunnels");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [deleteId, setDeleteId] = React.useState<TunnelRow | null>(null);
  const [stopId, setStopId] = React.useState<TunnelRow | null>(null);
  const [logsId, setLogsId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = React.useState(false);

  const allSelected = tunnels.length > 0 && selected.size === tunnels.length;
  const someSelected = selected.size > 0 && !allSelected;

  function toggleSelectAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(tunnels.map((r) => r.id)));
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runBatchAction(action: "start" | "stop" | "restart") {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setBatchBusy(true);
    const res = await apiFetch("/api/tunnels/batch", {
      method: "POST",
      body: JSON.stringify({ action, tunnelIds: ids }),
    });
    setBatchBusy(false);
    if (res.ok) {
      const data = res.data as { summary?: { succeeded: number; failed: number } };
      const s = data.summary;
      if (s && s.failed > 0) {
        toast.warning(`${s.succeeded} succeeded, ${s.failed} failed`);
      } else {
        toast.success(action === "start" ? t("batchStarted") : action === "stop" ? t("batchStopped") : t("batchRestarted"));
      }
      setSelected(new Set());
      router.refresh();
    } else {
      toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
    }
  }

  async function runAction(id: string, action: "start" | "stop" | "restart") {
    setBusyId(id);
    const res = await apiFetch(`/api/tunnels/${id}/actions`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    setBusyId(null);
    if (res.ok) {
      toast.success(action === "start" ? t("started") : action === "stop" ? t("stoppedMsg") : t("restarted"));
      router.refresh();
    } else {
      toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
    }
  }

  async function remove() {
    if (!deleteId) return;
    const res = await apiFetch(`/api/tunnels/${deleteId.id}`, { method: "DELETE" });
    setDeleteId(null);
    if (res.ok) {
      toast.success(t("deleted"));
      router.refresh();
    } else {
      toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
    }
  }

  async function exportConfig(row: TunnelRow) {
    const res = await apiFetch(`/api/tunnels/${row.id}`);
    if (!res.ok) return;
    const tunnel = (res.data as { tunnel: unknown }).tunnel;
    const blob = new Blob([JSON.stringify(tunnel, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${row.name}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <>
      {tunnels.length === 0 ? (
        <div className="animate-fade-in flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
          <Network className="h-8 w-8 text-muted-foreground/40" />
          <p className="text-muted-foreground">{t("empty")}</p>
          <Button asChild variant="outline" size="sm" className="mt-2">
            <a href="/tunnels/new">{t("new")}</a>
          </Button>
        </div>
      ) : (
        <>
          {selected.size > 0 && (
            <div className="animate-fade-in flex items-center gap-3 rounded-lg border bg-muted/50 px-4 py-2.5">
              <span className="text-sm text-muted-foreground">
                {t("selectedCount", { count: selected.size })}
              </span>
              <div className="flex items-center gap-1.5 ml-auto">
                <Button
                  size="sm"
                  disabled={batchBusy}
                  onClick={() => runBatchAction("start")}
                >
                  {batchBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Play className="h-3.5 w-3.5 mr-1" />}
                  {t("batchStart")}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={batchBusy}
                  onClick={() => runBatchAction("stop")}
                >
                  {batchBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Square className="h-3.5 w-3.5 mr-1" />}
                  {t("batchStop")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={batchBusy}
                  onClick={() => runBatchAction("restart")}
                >
                  {batchBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RotateCw className="h-3.5 w-3.5 mr-1" />}
                  {t("batchRestart")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelected(new Set())}
                >
                  {t("clearSelection")}
                </Button>
              </div>
            </div>
          )}

          <ResponsiveTable
            headers={[t("name"), t("method"), t("nodes"), t("port"), t("status"), t("actions")]}
          >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    className="flex items-center justify-center"
                    aria-label={allSelected ? t("deselectAll") : t("selectAll")}
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 items-center justify-center rounded border transition-colors",
                        allSelected
                          ? "border-primary bg-primary text-primary-foreground"
                          : someSelected
                            ? "border-primary bg-primary/20"
                            : "border-muted-foreground/40",
                      )}
                    >
                      {(allSelected || someSelected) && (
                        <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                          {allSelected ? <path d="M2 6l3 3 5-5" /> : <rect x="3" y="3" width="6" height="6" rx="1" fill="currentColor" stroke="none" />}
                        </svg>
                      )}
                    </span>
                  </button>
                </TableHead>
                <TableHead>{t("name")}</TableHead>
                <TableHead>{t("method")}</TableHead>
                <TableHead>{t("nodes")}</TableHead>
                <TableHead>{t("port")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead className="text-right">{t("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBodyWrapper>
              {tunnels.map((row, i) => (
                <TableRowWrapper key={row.id} className="animate-fade-in-up" style={{ "--stagger": Math.min(i, 10) } as React.CSSProperties}>
                  <TableCell className="w-10">
                    <button
                      type="button"
                      onClick={() => toggleSelect(row.id)}
                      className="flex items-center justify-center"
                      aria-label={selected.has(row.id) ? t("deselect") : t("select")}
                    >
                      <span
                        className={cn(
                          "flex h-4 w-4 items-center justify-center rounded border transition-colors",
                          selected.has(row.id)
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-muted-foreground/40",
                        )}
                      >
                        {selected.has(row.id) && (
                          <svg className="h-3 w-3" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M2 6l3 3 5-5" />
                          </svg>
                        )}
                      </span>
                    </button>
                  </TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {row.method}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.clientNode} → {row.serverNode}
                  </TableCell>
                  <TableCell>{row.port ?? "—"}</TableCell>
                  <TableCell>
                    <StatusBadge status={row.state} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        disabled={busyId === row.id}
                        onClick={() => {
                          if (row.state === "running") {
                            setStopId(row);
                          } else {
                            runAction(row.id, "start");
                          }
                        }}
                        aria-label={row.state === "running" ? tCommon("stop") : tCommon("start")}
                      >
                        {busyId === row.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : row.state === "running" ? (
                          <Square className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={tCommon("actions")}>
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setLogsId(row.id)}>
                            <Terminal className="h-4 w-4" />
                            {t("logViewer")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => runAction(row.id, "restart")}>
                            <RotateCw className="h-4 w-4" />
                            {tCommon("restart")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => exportConfig(row)}>
                            <Download className="h-4 w-4" />
                            {t("export")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeleteId(row)}
                          >
                            <Trash2 className="h-4 w-4" />
                            {tCommon("delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TableCell>
                </TableRowWrapper>
              ))}
            </TableBodyWrapper>
          </Table>
        </ResponsiveTable>
        </>
      )}

      <Dialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tCommon("delete")}</DialogTitle>
            <DialogDescription>
              {deleteId ? t("deleteConfirm", { name: deleteId.name }) : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>
              {tCommon("cancel")}
            </Button>
            <Button variant="destructive" onClick={remove}>
              {tCommon("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!stopId} onOpenChange={(o) => !o && setStopId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tCommon("stop")}</DialogTitle>
            <DialogDescription>
              {stopId ? t("stopConfirm", { name: stopId.name }) : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setStopId(null)}>
              {tCommon("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (stopId) {
                  runAction(stopId.id, "stop");
                  setStopId(null);
                }
              }}
            >
              {tCommon("stop")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {logsId && <LogViewer tunnelId={logsId} onClose={() => setLogsId(null)} />}
    </>
  );
}
