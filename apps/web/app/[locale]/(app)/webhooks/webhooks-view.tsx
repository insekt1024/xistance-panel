"use client";

import * as React from "react";
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
import { Card } from "@/components/ui/card";
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
        toast.success("Webhook updated");
        setOpen(false);
        setForm(EMPTY);
        setEditing(null);
        router.refresh();
      } else {
        toast.error((res.data as { error?: string })?.error ?? "Error");
      }
    } else {
      const res = await apiFetch("/api/webhooks", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setSaving(false);
      if (res.ok) {
        toast.success("Webhook created");
        setOpen(false);
        setForm(EMPTY);
        router.refresh();
      } else {
        toast.error((res.data as { error?: string })?.error ?? "Error");
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
    else toast.error((res.data as { error?: string })?.error ?? "Error");
  }

  async function remove() {
    if (!deleteId) return;
    const res = await apiFetch(`/api/webhooks/${deleteId.id}`, { method: "DELETE" });
    setDeleteId(null);
    if (res.ok) {
      toast.success("Webhook deleted");
      router.refresh();
    } else {
      toast.error((res.data as { error?: string })?.error ?? "Error");
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
          Add webhook
        </Button>
      </div>

      {initialWebhooks.length === 0 ? (
        <Card className="animate-fade-in border-dashed p-10 text-center text-muted-foreground">
          No webhooks configured. Add one to receive notifications.
        </Card>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Events</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {initialWebhooks.map((w, i) => (
              <TableRow
                key={w.id}
                className="animate-fade-in-up"
                style={{ "--stagger": Math.min(i, 10) } as React.CSSProperties}
              >
                <TableCell className="font-medium">{w.name}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">
                    {w.type === "telegram" ? "Telegram" : "Discord"}
                  </Badge>
                </TableCell>
                <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground font-mono">
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
                      <span className="text-xs text-muted-foreground">All</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Switch
                    checked={w.enabled}
                    disabled={busyId === w.id}
                    onCheckedChange={() => toggleEnabled(w)}
                  />
                </TableCell>
                <TableCell className="text-right">
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
            <DialogTitle>{editing ? "Edit webhook" : "Add webhook"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Admin Telegram"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select
                  value={form.type}
                  onValueChange={(v) => setForm({ ...form, type: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="telegram">Telegram</SelectItem>
                    <SelectItem value="discord">Discord</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <div className="flex h-9 items-center">
                  <Switch
                    checked={form.enabled}
                    onCheckedChange={(v) => setForm({ ...form, enabled: v })}
                  />
                  <span className="ml-2 text-sm text-muted-foreground">
                    {form.enabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Webhook URL</Label>
              <Input
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
              <Label>Events</Label>
              <p className="text-xs text-muted-foreground">
                Select specific events or leave empty to receive all notifications.
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
            <DialogTitle>Delete webhook</DialogTitle>
            <p className="text-sm text-muted-foreground">
              {deleteId ? `Delete webhook "${deleteId.name}"? This cannot be undone.` : ""}
            </p>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={remove}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
