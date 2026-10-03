"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { toast } from "sonner";
import { Loader2, Plus, Pencil, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StateBlock } from "@/components/state-block";
import { Badge } from "@/components/ui/badge";

export interface WebhookRow {
  id: string;
  name: string;
  type: string;
  url: string;
  events: string;
  enabled: boolean;
  createdAt: string;
}

const AVAILABLE_EVENTS = [
  "tunnel.started",
  "tunnel.stopped",
  "tunnel.error",
  "node.offline",
];

const EMPTY = { name: "", type: "telegram", url: "", events: [] as string[], enabled: true };

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 12 ? u.pathname.slice(0, 8) + "..." + u.pathname.slice(-4) : u.pathname;
    return u.origin + path;
  } catch {
    return url.length > 40 ? url.slice(0, 20) + "..." + url.slice(-8) : url;
  }
}

function parseEvents(events: string): string[] {
  try {
    const parsed = JSON.parse(events);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function WebhooksView({ initialWebhooks }: { initialWebhooks: WebhookRow[] }) {
  const t = useTranslations("webhooks");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<WebhookRow | null>(null);
  const [form, setForm] = React.useState(EMPTY);
  const [saving, setSaving] = React.useState(false);
  const [deleteId, setDeleteId] = React.useState<WebhookRow | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY);
    setOpen(true);
  }

  function openEdit(w: WebhookRow) {
    setEditing(w);
    setForm({
      name: w.name,
      type: w.type,
      url: w.url,
      events: parseEvents(w.events),
      enabled: w.enabled,
    });
    setOpen(true);
  }

  async function submit() {
    setSaving(true);
    if (editing) {
      const res = await apiFetch(`/api/webhooks/${editing.id}`, {
        method: "PUT",
        body: JSON.stringify(form),
      });
      setSaving(false);
      if (res.ok) {
        toast.success(t("updated"));
        setOpen(false);
        setForm(EMPTY);
        setEditing(null);
        router.refresh();
      } else {
        toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
      }
    } else {
      const res = await apiFetch("/api/webhooks", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setSaving(false);
      if (res.ok) {
        toast.success(t("created"));
        setOpen(false);
        setForm(EMPTY);
        router.refresh();
      } else {
        toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
      }
    }
  }

  async function toggleEnabled(w: WebhookRow) {
    setBusyId(w.id);
    const res = await apiFetch(`/api/webhooks/${w.id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: !w.enabled }),
    });
    setBusyId(null);
    if (res.ok) router.refresh();
    else toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
  }

  async function remove() {
    if (!deleteId) return;
    const res = await apiFetch(`/api/webhooks/${deleteId.id}`, { method: "DELETE" });
    setDeleteId(null);
    if (res.ok) {
      toast.success(t("deleted"));
      router.refresh();
    } else {
      toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
    }
  }

  function toggleEvent(event: string) {
    setForm((prev) => ({
      ...prev,
      events: prev.events.includes(event)
        ? prev.events.filter((e) => e !== event)
        : [...prev.events, event],
    }));
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" />
          {t("add")}
        </Button>
      </div>

      {initialWebhooks.length === 0 ? (
        // This was a hand-rolled Card, so unlike every other list it offered no
        // next step and announced nothing on arrival. StateBlock is the shared
        // component every other view already uses.
        <StateBlock
          kind="empty"
          message={t("empty")}
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus aria-hidden className="size-4" />
              {t("add")}
            </Button>
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">{t("name")}</TableHead>
              <TableHead className="whitespace-nowrap">{t("type")}</TableHead>
              <TableHead className="whitespace-nowrap">{t("url")}</TableHead>
              <TableHead className="whitespace-nowrap">{t("events")}</TableHead>
              <TableHead className="whitespace-nowrap">{t("enabled")}</TableHead>
              <TableHead className="text-left rtl:text-right">{t("actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initialWebhooks.map((w, i) => (
              <TableRow
                key={w.id}
                className="animate-fade-in-up"
                style={{ "--stagger": Math.min(i, 10) } as React.CSSProperties}
              >
                {/* An identifier in a table cell. The wrapper already scrolls horizontally, so `whitespace-nowrap` lets the TABLE scroll rather than wrapping the value across several lines in a narrow column. Measured with realistic long values by test-dashboard-legibility.ts. */}
                <TableCell className="whitespace-nowrap font-medium">{w.name}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">
                    {w.type === "telegram" ? t("telegram") : t("discord")}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-[200px] min-w-[200px] truncate text-sm text-muted-foreground font-mono">
                  {maskUrl(w.url)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {parseEvents(w.events).length > 0 ? (
                      parseEvents(w.events).map((e) => (
                        <Badge key={e} variant="secondary" className="text-xs">
                          {e}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-xs text-muted-foreground">{t("allEvents")}</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Switch
                    id={`webhook-enabled-${w.id}`}
                    aria-label={t("toggleEnabled", { name: w.name })}
                    checked={w.enabled}
                    disabled={busyId === w.id}
                    onCheckedChange={() => toggleEnabled(w)}
                  />
                </TableCell>
                <TableCell className="text-left rtl:text-right">
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(w)}>
                      {busyId === w.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Pencil className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      onClick={() => setDeleteId(w)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("edit") : t("add")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="webhook-name">{t("name")}</Label>
              <Input
                id="webhook-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder={t("namePlaceholder")}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="webhook-type">{t("type")}</Label>
                <Select
                  value={form.type}
                  onValueChange={(v) => setForm({ ...form, type: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="telegram">{t("telegram")}</SelectItem>
                    <SelectItem value="discord">{t("discord")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label id="webhook-status-label">{t("status")}</Label>
                <div className="flex h-9 items-center">
                  <Switch
                    checked={form.enabled}
                    onCheckedChange={(v) => setForm({ ...form, enabled: v })}
                  />
                  <span className="ms-2 text-sm text-muted-foreground">
                    {form.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="webhook-url">{t("url")}</Label>
              <Input
                id="webhook-url"
                type="url"
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                placeholder={
                  form.type === "telegram"
                    ? "https://api.telegram.org/bot<token>/sendMessage"
                    : "https://discord.com/api/webhooks/<id>/<token>"
                }
              />
            </div>
            <div className="space-y-2">
              <Label>{t("events")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("eventsHint")}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {AVAILABLE_EVENTS.map((event) => (
                  <label
                    key={event}
                    className="flex items-center gap-2 rounded-md border p-2 text-sm cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={form.events.includes(event)}
                      onChange={() => toggleEvent(event)}
                      className="h-4 w-4 rounded border-input"
                    />
                    <span className="font-mono text-xs">{event}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={saving || !form.name || !form.url}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("delete")}</DialogTitle>
            <p className="text-sm text-muted-foreground">
              {deleteId ? t("deleteConfirm", { name: deleteId.name }) : ""}
            </p>
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
    </div>
  );
}
