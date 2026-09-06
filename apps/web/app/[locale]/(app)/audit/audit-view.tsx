"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { apiFetch } from "@/lib/client";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card } from "@/components/ui/card";

interface AuditActor {
  id: string;
  name: string;
  email: string;
}

interface AuditLogRow {
  id: string;
  actorId: string | null;
  action: string;
  target: string | null;
  details: string | null;
  ip: string | null;
  createdAt: string;
  actor: AuditActor | null;
}

interface AuditResponse {
  logs: AuditLogRow[];
  hasNext: boolean;
  nextCursor: string | null;
}

async function loadPage(cursor: string | null): Promise<AuditResponse | null> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  const res = await apiFetch<AuditResponse>(`/api/audit?${params}`);
  return res.ok ? res.data : null;
}

interface Props {
  initialLogs: AuditLogRow[];
  initialHasNext: boolean;
  initialNextCursor: string | null;
}

export function AuditView({ initialLogs, initialHasNext, initialNextCursor }: Props) {
  const t = useTranslations("audit");
  const tCommon = useTranslations("common");

  const [logs, setLogs] = React.useState(initialLogs);
  const [loading, setLoading] = React.useState(false);
  const [nextCursor, setNextCursor] = React.useState(initialNextCursor);
  const [hasNext, setHasNext] = React.useState(initialHasNext);
  const [history, setHistory] = React.useState<(string | null)[]>([null]);

  async function navigate(cursor: string | null) {
    setLoading(true);
    const data = await loadPage(cursor);
    if (data) {
      setLogs(data.logs);
      setHasNext(data.hasNext);
      setNextCursor(data.nextCursor);
    }
    setLoading(false);
  }

  function goNext() {
    if (!hasNext) return;
    setHistory((h) => [...h, nextCursor]);
    navigate(nextCursor);
  }

  function goPrev() {
    if (history.length <= 1) return;
    const prev = history[history.length - 2];
    setHistory((h) => h.slice(0, -1));
    navigate(prev);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("subtitle")}</p>
      </div>

      {logs.length === 0 && !loading ? (
        <Card className="animate-fade-in border-dashed p-10 text-center text-muted-foreground">
          {t("empty")}
        </Card>
      ) : (
        <div className="space-y-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("time")}</TableHead>
                <TableHead>{t("actor")}</TableHead>
                <TableHead>{t("action")}</TableHead>
                <TableHead>{t("target")}</TableHead>
                <TableHead>{t("ip")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    {tCommon("loading")}
                  </TableCell>
                </TableRow>
              ) : (
                logs.map((log, i) => (
                  <TableRow
                    key={log.id}
                    className="animate-fade-in-up"
                    style={{ "--stagger": Math.min(i, 10) } as React.CSSProperties}
                  >
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(log.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      {log.actor ? (
                        <span className="font-medium">{log.actor.name}</span>
                      ) : (
                        <span className="text-muted-foreground">{t("system")}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{log.action}</code>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground">
                      {log.details ?? log.target ?? "—"}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{log.ip ?? "—"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={goPrev}
              disabled={history.length <= 1 || loading}
            >
              <ChevronLeft className="h-4 w-4" />
              {tCommon("back")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={goNext}
              disabled={!hasNext || loading}
            >
              {tCommon("next")}
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
