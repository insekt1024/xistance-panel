"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
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

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  quota: number;
  active: boolean;
  createdAt: string;
}

const EMPTY = { email: "", name: "", role: "USER", quota: 5, password: "" };

export function UsersView({ users, isAdmin }: { users: UserRow[]; isAdmin: boolean }) {
  const t = useTranslations("users");
  const tRole = useTranslations("role");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState(EMPTY);
  const [saving, setSaving] = React.useState(false);
  const [generated, setGenerated] = React.useState<string | null>(null);
  const [deleteId, setDeleteId] = React.useState<UserRow | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  async function submit() {
    setSaving(true);
    const res = await apiFetch<{ user: { generatedPassword?: string } }>("/api/users", {
      method: "POST",
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (res.ok) {
      if (res.data.user?.generatedPassword) {
        setGenerated(res.data.user.generatedPassword);
      } else {
        toast.success(t("saved"));
        setOpen(false);
        setForm(EMPTY);
        router.refresh();
      }
    } else {
      toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
    }
  }

  async function toggleActive(u: UserRow) {
    setBusyId(u.id);
    const res = await apiFetch(`/api/users/${u.id}`, {
      method: "PUT",
      body: JSON.stringify({ active: !u.active }),
    });
    setBusyId(null);
    if (res.ok) router.refresh();
    else toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
  }

  async function remove() {
    if (!deleteId) return;
    const res = await apiFetch(`/api/users/${deleteId.id}`, { method: "DELETE" });
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
      {isAdmin && (
        <div className="flex justify-end">
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" />
            {t("addUser")}
          </Button>
        </div>
      )}

      {users.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">{t("empty")}</Card>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("name")}</TableHead>
              <TableHead>{t("email")}</TableHead>
              <TableHead>{t("role")}</TableHead>
              <TableHead>{t("quota")}</TableHead>
              <TableHead>{t("active")}</TableHead>
              {isAdmin && <TableHead className="text-right">{tCommon("actions")}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.name}</TableCell>
                <TableCell className="text-sm">{u.email}</TableCell>
                <TableCell>
                  <Badge variant="outline">{tRole(u.role as keyof typeof tRole)}</Badge>
                </TableCell>
                <TableCell>{u.quota}</TableCell>
                <TableCell>
                  <Switch
                    checked={u.active}
                    disabled={!isAdmin || busyId === u.id}
                    onCheckedChange={() => toggleActive(u)}
                  />
                </TableCell>
                {isAdmin && (
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      onClick={() => setDeleteId(u)}
                    >
                      {busyId === u.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("addUser")}</DialogTitle>
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
                <Label>{t("email")}</Label>
                <Input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("role")}</Label>
                <Select
                  value={form.role}
                  onValueChange={(v) => setForm({ ...form, role: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USER">{tRole("USER")}</SelectItem>
                    <SelectItem value="ADMIN">{tRole("ADMIN")}</SelectItem>
                    <SelectItem value="SUPER_ADMIN">{tRole("SUPER_ADMIN")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("quota")}</Label>
                <Input
                  type="number"
                  value={form.quota}
                  onChange={(e) => setForm({ ...form, quota: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("password")}</Label>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                placeholder={t("passwordHint")}
              />
            </div>
            {generated && (
              <div className="rounded-md border border-primary/40 bg-primary/5 p-3">
                <p className="text-xs text-muted-foreground">{t("generatedPassword")}</p>
                <code className="mt-1 block font-mono text-sm">{generated}</code>
              </div>
            )}
          </div>
          <DialogFooter>
            {generated ? (
              <Button onClick={() => { setOpen(false); setGenerated(null); setForm(EMPTY); router.refresh(); }}>
                {tCommon("close")}
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={() => setOpen(false)}>
                  {tCommon("cancel")}
                </Button>
                <Button onClick={submit} disabled={saving}>
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  {tCommon("save")}
                </Button>
              </>
            )}
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
