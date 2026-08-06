"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import {
  Download,
  Loader2,
  MoreHorizontal,
  Play,
  RotateCw,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { apiFetch } from "@/lib/client";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { LogViewer } from "./log-viewer";

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
  const [logsId, setLogsId] = React.useState<string | null>(null);

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
        <div className="flex flex-col items-center gap-2 rounded-lg border py-16 text-center">
          <p className="text-muted-foreground">{t("empty")}</p>
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
              <TableHead className="text-right">{t("actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tunnels.map((row) => (
              <TableRow key={row.id}>
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
                      onClick={() => runAction(row.id, row.state === "running" ? "stop" : "start")}
                      title={row.state === "running" ? tCommon("stop") : tCommon("start")}
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
                        <Button variant="ghost" size="icon" className="h-8 w-8">
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
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

      {logsId && <LogViewer tunnelId={logsId} onClose={() => setLogsId(null)} />}
    </>
  );
}
