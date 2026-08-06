"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { toast } from "sonner";
import { Loader2, Plus, Power, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/client";
import { StatusBadge } from "@/components/status-badge";
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

export interface ForwardRow {
  id: string;
  name: string;
  direction: string;
  protocol: string;
  sourcePort: number;
  destHost: string;
  destPort: number;
  enabled: boolean;
  status: string;
}

const EMPTY = {
  name: "",
  direction: "IRAN_TO_FOREIGN",
  protocol: "tcp",
  sourcePort: 8080,
  destHost: "",
  destPort: 80,
  enabled: true,
};

export function PortForwardView({ rules }: { rules: ForwardRow[] }) {
  const t = useTranslations("portForward");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState(EMPTY);
  const [saving, setSaving] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [deleteId, setDeleteId] = React.useState<ForwardRow | null>(null);

  async function submit() {
    setSaving(true);
    const res = await apiFetch("/api/port-forwards", {
      method: "POST",
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (res.ok) {
      toast.success(t("saved"));
      setOpen(false);
      setForm(EMPTY);
      router.refresh();
    } else {
      toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
    }
  }

  async function toggle(row: ForwardRow) {
    setBusyId(row.id);
    const res = await apiFetch(`/api/port-forwards/${row.id}`, {
      method: "PUT",
      body: JSON.stringify({ enabled: !row.enabled }),
    });
    setBusyId(null);
    if (res.ok) {
      router.refresh();
    } else {
      toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
    }
  }

  async function remove() {
    if (!deleteId) return;
    const res = await apiFetch(`/api/port-forwards/${deleteId.id}`, { method: "DELETE" });
    setDeleteId(null);
    if (res.ok) {
      toast.success(t("deleted"));
      router.refresh();
    } else {
      toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" />
          {t("addRule")}
        </Button>
      </div>

      {rules.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">{t("empty")}</Card>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("name")}</TableHead>
              <TableHead>{t("direction")}</TableHead>
              <TableHead>{t("protocol")}</TableHead>
              <TableHead>{t("sourcePort")}</TableHead>
              <TableHead>{t("destHost")}</TableHead>
              <TableHead>{t("destPort")}</TableHead>
              <TableHead>{t("enabled")}</TableHead>
              <TableHead className="text-right">{tCommon("actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rules.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell>
                  {r.direction === "IRAN_TO_FOREIGN" ? t("iranToForeign") : t("foreignToIran")}
                </TableCell>
                <TableCell>{r.protocol.toUpperCase()}</TableCell>
                <TableCell className="font-mono text-xs">{r.sourcePort}</TableCell>
                <TableCell className="font-mono text-xs">{r.destHost}</TableCell>
                <TableCell className="font-mono text-xs">{r.destPort}</TableCell>
                <TableCell>
                  <StatusBadge status={r.enabled ? "running" : "stopped"} />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      disabled={busyId === r.id}
                      onClick={() => toggle(r)}
                      title={r.enabled ? tCommon("stop") : tCommon("start")}
                    >
                      {busyId === r.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Power className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      onClick={() => setDeleteId(r)}
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("addRule")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("name")}</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("direction")}</Label>
                <Select
                  value={form.direction}
                  onValueChange={(v) => setForm({ ...form, direction: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="IRAN_TO_FOREIGN">{t("iranToForeign")}</SelectItem>
                    <SelectItem value="FOREIGN_TO_IRAN">{t("foreignToIran")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("protocol")}</Label>
                <Select
                  value={form.protocol}
                  onValueChange={(v) => setForm({ ...form, protocol: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tcp">{t("tcp")}</SelectItem>
                    <SelectItem value="udp">{t("udp")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("sourcePort")}</Label>
                <Input
                  type="number"
                  value={form.sourcePort}
                  onChange={(e) =>
                    setForm({ ...form, sourcePort: Number(e.target.value) })
                  }
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("destHost")}</Label>
                <Input
                  value={form.destHost}
                  onChange={(e) => setForm({ ...form, destHost: e.target.value })}
                  placeholder="127.0.0.1"
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("destPort")}</Label>
                <Input
                  type="number"
                  value={form.destPort}
                  onChange={(e) => setForm({ ...form, destPort: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                checked={form.enabled}
                onCheckedChange={(c) => setForm({ ...form, enabled: c })}
              />
              <Label>{t("enabled")}</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tCommon("delete")}</DialogTitle>
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
