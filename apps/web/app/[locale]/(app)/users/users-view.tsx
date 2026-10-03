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
import { Badge } from "@/components/ui/badge";
import { StateBlock } from "@/components/state-block";

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
          <StateBlock
    kind="empty"
    message={t("empty")}
    description={t("emptyHint")}
    action={
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus aria-hidden className="size-4" />
        {t("addUser")}
      </Button>
    }
  />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">{t("name")}</TableHead>
              <TableHead className="whitespace-nowrap">{t("email")}</TableHead>
              <TableHead className="whitespace-nowrap">{t("role")}</TableHead>
              <TableHead className="whitespace-nowrap">{t("quota")}</TableHead>
              <TableHead className="whitespace-nowrap">{t("active")}</TableHead>
              {isAdmin && <TableHead className="text-left rtl:text-right">{tCommon("actions")}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u, i) => (
              <TableRow key={u.id} className="animate-fade-in-up" style={{ "--stagger": Math.min(i, 10) } as React.CSSProperties}>
                {/* An identifier in a table cell. The wrapper already scrolls horizontally, so `whitespace-nowrap` lets the TABLE scroll rather than wrapping the value across several lines in a narrow column. Measured with realistic long values by test-dashboard-legibility.ts. */}
                <TableCell className="whitespace-nowrap font-medium">{u.name}</TableCell>
                {/* An identifier in a table cell. The wrapper already scrolls horizontally, so `whitespace-nowrap` lets the TABLE scroll rather than wrapping the value across several lines in a narrow column. Measured with realistic long values by test-dashboard-legibility.ts. */}
                <TableCell className="whitespace-nowrap text-sm">{u.email}</TableCell>
                <TableCell>
                  <Badge variant="outline">{tRole(u.role as keyof typeof tRole)}</Badge>
                </TableCell>
                <TableCell>{u.quota}</TableCell>
                <TableCell>
                  <Switch
                    // Both the switch and the delete button below were icon- or
                    // shape-only controls with no accessible name, so a screen
                    // reader announced "switch, button" with nothing useful.
                    id={`user-active-${u.id}`}
                    aria-label={u.active ? t("deactivate") : t("activate")}
                    checked={u.active}
                    disabled={!isAdmin || busyId === u.id}
                    onCheckedChange={() => toggleActive(u)}
                  />
                </TableCell>
                {isAdmin && (
                  <TableCell className="text-left rtl:text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      aria-label={t("deleteUser", { name: u.name })}
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
                <Label htmlFor="user-name">{t("name")}</Label>
                <Input
                  id="user-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="user-email">{t("email")}</Label>
                <Input
                  id="user-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="user-role">{t("role")}</Label>
                <Select
                  value={form.role}
                  onValueChange={(v) => setForm({ ...form, role: v })}
                >
                  <SelectTrigger id="user-role">
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
                <Label htmlFor="user-quota">{t("quota")}</Label>
                <Input
                  id="user-quota"
                  type="number"
                  value={form.quota}
                  onChange={(e) => setForm({ ...form, quota: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="user-password">{t("password")}</Label>
              <Input
                id="user-password"
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
