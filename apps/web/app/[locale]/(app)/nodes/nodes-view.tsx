"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import { apiFetch } from "@/lib/client";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card } from "@/components/ui/card";

export interface NodeRow {
  id: string;
  name: string;
  type: "IRAN" | "FOREIGN";
  host: string;
  sshPort: number;
  sshUser: string;
  authMethod: string;
  status: string;
  sshKeyEncrypted: string | null;
  sshPasswordEnc: string | null;
  createdAt: string;
}

const EMPTY_FORM = {
  name: "",
  type: "IRAN" as "IRAN" | "FOREIGN",
  host: "",
  port: 22,
  username: "root",
  authMethod: "key",
  key: "",
  password: "",
};

export function NodesView({ nodes }: { nodes: NodeRow[] }) {
  const t = useTranslations("nodes");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [form, setForm] = React.useState(EMPTY_FORM);
  const [saving, setSaving] = React.useState(false);
  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [deleteId, setDeleteId] = React.useState<NodeRow | null>(null);
  const [testResult, setTestResult] = React.useState<Record<string, boolean>>({});

  async function submit() {
    setSaving(true);
    const res = await apiFetch("/api/nodes", {
      method: "POST",
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (res.ok) {
      toast.success(t("saved"));
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      router.refresh();
    } else {
      toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
    }
  }

  async function test(node: NodeRow) {
    setTestingId(node.id);
    setTestResult((r) => ({ ...r, [node.id]: true }));
    const res = await apiFetch(`/api/nodes/${node.id}/test`, { method: "POST" });
    setTestingId(null);
    setTestResult((r) => ({ ...r, [node.id]: res.ok }));
    if (res.ok) {
      toast.success(t("reachable"));
    } else {
      toast.error((res.data as { message?: string })?.message ?? t("unreachable"));
    }
    router.refresh();
  }

  async function remove() {
    if (!deleteId) return;
    const res = await apiFetch(`/api/nodes/${deleteId.id}`, { method: "DELETE" });
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
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          {t("add")}
        </Button>
      </div>

      {nodes.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">{t("empty")}</Card>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("name")}</TableHead>
              <TableHead>{t("type")}</TableHead>
              <TableHead>{t("host")}</TableHead>
              <TableHead>{t("sshPort")}</TableHead>
              <TableHead>{t("authMethod")}</TableHead>
              <TableHead>{t("status")}</TableHead>
              <TableHead className="text-right">{tCommon("actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map((n) => (
              <TableRow key={n.id}>
                <TableCell className="font-medium">{n.name}</TableCell>
                <TableCell>
                  {n.type === "IRAN" ? t("iran") : t("foreign")}
                </TableCell>
                <TableCell className="font-mono text-xs">{n.host}</TableCell>
                <TableCell>{n.sshPort}</TableCell>
                <TableCell>
                  {n.authMethod === "key" ? (
                    n.sshKeyEncrypted ? (
                      "🔑 key"
                    ) : (
                      <span className="text-muted-foreground">key —</span>
                    )
                  ) : (
                    t("password")
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={n.status} />
                </TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        {testingId === n.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : testResult[n.id] ? (
                          <CheckCircle2 className="h-4 w-4 text-success" />
                        ) : testResult[n.id] === false ? (
                          <XCircle className="h-4 w-4 text-destructive" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => test(n)}>
                        <RefreshCw className="h-4 w-4" />
                        {t("testConnection")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive"
                        onClick={() => setDeleteId(n)}
                      >
                        <Trash2 className="h-4 w-4" />
                        {tCommon("delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("add")}</DialogTitle>
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
                <Label>{t("type")}</Label>
                <Select
                  value={form.type}
                  onValueChange={(v) => setForm({ ...form, type: v as "IRAN" | "FOREIGN" })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="IRAN">{t("iran")}</SelectItem>
                    <SelectItem value="FOREIGN">{t("foreign")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("host")}</Label>
              <Input
                value={form.host}
                onChange={(e) => setForm({ ...form, host: e.target.value })}
                placeholder="203.0.113.10"
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("sshPort")}</Label>
                <Input
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>{t("username")}</Label>
                <Input
                  value={form.username}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("authMethod")}</Label>
              <Select
                value={form.authMethod}
                onValueChange={(v) => setForm({ ...form, authMethod: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="key">{t("key")}</SelectItem>
                  <SelectItem value="password">{t("password")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.authMethod === "key" ? (
              <div className="space-y-1.5">
                <Label>{t("key")}</Label>
                <textarea
                  className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  value={form.key}
                  onChange={(e) => setForm({ ...form, key: e.target.value })}
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>{t("password")}</Label>
                <Input
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
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
