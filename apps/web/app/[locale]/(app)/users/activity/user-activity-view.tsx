"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Filter, X } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ActivityActor {
  id: string;
  name: string;
  email: string;
}

interface ActivityLogRow {
  id: string;
  actorId: string | null;
  action: string;
  target: string | null;
  details: string | null;
  ip: string | null;
  createdAt: string;
  actor: ActivityActor | null;
}

interface ActivityResponse {
  logs: ActivityLogRow[];
  hasNext: boolean;
  nextCursor: string | null;
  actionTypes: string[];
}

interface UserOption {
  id: string;
  name: string;
  email: string;
}

interface Props {
  initialLogs: ActivityLogRow[];
  initialHasNext: boolean;
  initialNextCursor: string | null;
  initialActionTypes: string[];
  users: UserOption[];
}

async function loadPage(
  cursor: string | null,
  userId: string | null,
  action: string | null,
): Promise<ActivityResponse | null> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (userId) params.set("userId", userId);
  if (action) params.set("action", action);
  const res = await apiFetch<ActivityResponse>(`/api/users/activity?${params}`);
  return res.ok ? res.data : null;
}

export function UserActivityView({
  initialLogs,
  initialHasNext,
  initialNextCursor,
  initialActionTypes,
  users,
}: Props) {
  const t = useTranslations("userActivity");
  const tCommon = useTranslations("common");

  const [logs, setLogs] = React.useState(initialLogs);
  const [loading, setLoading] = React.useState(false);
  const [nextCursor, setNextCursor] = React.useState(initialNextCursor);
  const [hasNext, setHasNext] = React.useState(initialHasNext);
  const [history, setHistory] = React.useState<(string | null)[]>([null]);
  const [actionTypes] = React.useState(initialActionTypes);

  const [filterUser, setFilterUser] = React.useState<string>("all");
  const [filterAction, setFilterAction] = React.useState<string>("all");

  const hasFilters = filterUser !== "all" || filterAction !== "all";

  async function navigate(cursor: string | null) {
    setLoading(true);
    const data = await loadPage(
      cursor,
      filterUser === "all" ? null : filterUser,
      filterAction === "all" ? null : filterAction,
    );
    if (data) {
      setLogs(data.logs);
      setHasNext(data.hasNext);
      setNextCursor(data.nextCursor);
    }
    setLoading(false);
  }

  function applyFilters() {
    setHistory([null]);
    navigate(null);
  }

  function clearFilters() {
    setFilterUser("all");
    setFilterAction("all");
    setHistory([null]);
    setLoading(true);
    loadPage(null, null, null).then((data) => {
      if (data) {
        setLogs(data.logs);
        setHasNext(data.hasNext);
        setNextCursor(data.nextCursor);
      }
      setLoading(false);
    });
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
    <div className="space-y-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Filter className="h-4 w-4" />
            {t("filters")}
          </div>
          <div className="flex-1 min-w-[140px]">
            <Select value={filterUser} onValueChange={setFilterUser}>
              <SelectTrigger>
                <SelectValue placeholder={t("allUsers")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("allUsers")}</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name} ({u.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 min-w-[140px]">
            <Select value={filterAction} onValueChange={setFilterAction}>
              <SelectTrigger>
                <SelectValue placeholder={t("allActions")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("allActions")}</SelectItem>
                {actionTypes.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" onClick={applyFilters} disabled={loading}>
            {t("apply")}
          </Button>
          {hasFilters && (
            <Button size="sm" variant="ghost" onClick={clearFilters}>
              <X className="h-3.5 w-3.5" />
              {t("clear")}
            </Button>
          )}
        </div>
      </Card>

      {logs.length === 0 && !loading ? (
        <Card className="animate-fade-in border-dashed p-10 text-center text-muted-foreground">
          {t("empty")}
        </Card>
      ) : (
        <div className="space-y-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("user")}</TableHead>
                <TableHead>{t("action")}</TableHead>
                <TableHead>{t("target")}</TableHead>
                <TableHead>{t("time")}</TableHead>
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
                    <TableCell>
                      {log.actor ? (
                        <div className="flex flex-col">
                          <span className="font-medium">{log.actor.name}</span>
                          <span className="text-xs text-muted-foreground">{log.actor.email}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">{t("system")}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-xs">
                        {log.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground">
                      {log.details ?? log.target ?? "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {new Date(log.createdAt).toLocaleString()}
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
