"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { StateBlock } from "@/components/state-block";

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
    try {
      const data = await loadPage(cursor);
      if (data) {
        setLogs(data.logs);
        setHasNext(data.hasNext);
        setNextCursor(data.nextCursor);
      }
    } catch {
      toast.error(tCommon("networkError"));
    } finally {
      setLoading(false);
    }
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

      {loading ? <StateBlock kind="loading" message={t("loading")} /> : null}
      {logs.length === 0 && !loading ? (
        <StateBlock
          kind="empty"
          message={t("empty")}
          description={t("emptyHint")}
          action={
            <Button size="sm" variant="outline" onClick={goPrev} disabled={history.length <= 1 || loading}>
              <ChevronLeft aria-hidden className="size-4" />
              {t("prev")}
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">{t("time")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("actor")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("action")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("target")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("ip")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow aria-hidden>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    <Loader2 className="mx-auto size-4 animate-spin" />
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
                        /* An actor name is an IDENTIFIER, so it must not wrap:
                           measured at 85px, "Super Admin" broke across two lines
                           inside a one-line box. But this column is NOT inside the
                           scrollable wrapper the other tables use, so a bare
                           `whitespace-nowrap` overflowed its cell by up to 154px.

                           The right answer for a bounded column is truncation,
                           with the full value still reachable: `title` carries
                           it for a pointer user, and the row itself is a record
                           the user can inspect. Found by
                           test-dashboard-legibility.ts. */
                        <span
                          className="block max-w-[180px] truncate font-medium"
                          title={log.actor.name}
                        >
                          {log.actor.name}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t("system")}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {/* py-0.5 on a 12px code chip is what pushed the box to
                          24px of content inside a 20px line and clipped it. The chip is
                          now inline-flex with an explicit line-height, so its box is
                          derived from its text rather than from padding stacked on top
                          of it. Measured by test-dashboard-legibility.ts. */}
                      <code className="inline-flex items-center whitespace-nowrap rounded bg-muted px-1.5 text-xs leading-5">
                        {log.action}
                      </code>
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
