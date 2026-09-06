"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Pencil, Plus, RefreshCw, Trash2, XCircle } from "lucide-react";
import { apiFetch } from "@/lib/client";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormInput, FormSelect, useFieldValidation } from "@/components/ui/form-field";
import {
  SelectItem,
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
  const [editingNode, setEditingNode] = React.useState<NodeRow | null>(null);
  const [editForm, setEditForm] = React.useState(EMPTY_FORM);
  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [deleteId, setDeleteId] = React.useState<NodeRow | null>(null);
  const [testResult, setTestResult] = React.useState<Record<string, boolean>>({});

  const nameField = useFieldValidation(form.name, { required: true, minLength: 2, maxLength: 64 });
  const hostField = useFieldValidation(form.host, {
    required: true,
    pattern: /^[\w.-]+$/,
    patternMessage: "Invalid hostname or IP",
  });
  const usernameField = useFieldValidation(form.username, { required: true, minLength: 1 });
  const keyField = useFieldValidation(form.key, {
    validate: (v) =>
      form.authMethod === "key" && !v.trim() ? "SSH key is required" : undefined,
  });

  const isAddValid = nameField.valid && hostField.valid && usernameField.valid && keyField.valid;

  const editNameField = useFieldValidation(editForm.name, { required: true, minLength: 2, maxLength: 64 });
  const editHostField = useFieldValidation(editForm.host, {
    required: true,
    pattern: /^[\w.-]+$/,
    patternMessage: "Invalid hostname or IP",
  });
  const editUsernameField = useFieldValidation(editForm.username, { required: true, minLength: 1 });
  const editKeyField = useFieldValidation(editForm.key, {
    validate: (v) =>
      editForm.authMethod === "key" && !v.trim() ? "SSH key is required" : undefined,
  });

  const isEditValid =
    editNameField.valid && editHostField.valid && editUsernameField.valid && editKeyField.valid;

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

  function openEdit(node: NodeRow) {
    setEditingNode(node);
    setEditForm({
      name: node.name,
      type: node.type,
      host: node.host,
      port: node.sshPort,
      username: node.sshUser,
      authMethod: node.authMethod,
      key: "",
      password: "",
    });
  }

  async function editSubmit() {
    if (!editingNode) return;
    setSaving(true);
    const res = await apiFetch(`/api/nodes/${editingNode.id}`, {
      method: "PUT",
      body: JSON.stringify(editForm),
    });
    setSaving(false);
    if (res.ok) {
      toast.success(t("saved"));
      setEditingNode(null);
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
        <Card className="animate-fade-in border-dashed p-10 text-center text-muted-foreground">{t("empty")}</Card>
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
            {nodes.map((n, i) => (
              <TableRow key={n.id} className="animate-fade-in-up" style={{ "--stagger": Math.min(i, 10) } as React.CSSProperties}>
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
                      <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={tCommon("actions")}>
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
                      <DropdownMenuItem onClick={() => openEdit(n)}>
                        <Pencil className="h-4 w-4" />
                        {tCommon("edit")}
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
              <FormInput
                label={t("name")}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                onBlur={() => nameField.setTouched(true)}
                error={nameField.error}
                required
              />
              <FormSelect
                label={t("type")}
                value={form.type}
                onValueChange={(v) => setForm({ ...form, type: v as "IRAN" | "FOREIGN" })}
                required
                valid={!!form.type}
              >
                <SelectItem value="IRAN">{t("iran")}</SelectItem>
                <SelectItem value="FOREIGN">{t("foreign")}</SelectItem>
              </FormSelect>
            </div>
            <FormInput
              label={t("host")}
              value={form.host}
              onChange={(e) => setForm({ ...form, host: e.target.value })}
              onBlur={() => hostField.setTouched(true)}
              placeholder="203.0.113.10"
              error={hostField.error}
              required
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormInput
                label={t("sshPort")}
                type="number"
                value={form.port}
                onChange={(e) => setForm({ ...form, port: Number(e.target.value) })}
              />
              <FormInput
                label={t("username")}
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
                onBlur={() => usernameField.setTouched(true)}
                error={usernameField.error}
                required
              />
            </div>
            <FormSelect
              label={t("authMethod")}
              value={form.authMethod}
              onValueChange={(v) => setForm({ ...form, authMethod: v })}
              required
              valid={!!form.authMethod}
            >
              <SelectItem value="key">{t("key")}</SelectItem>
              <SelectItem value="password">{t("password")}</SelectItem>
            </FormSelect>
            {form.authMethod === "key" ? (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t("key")}
                  <span className="ml-0.5 text-destructive">*</span>
                </label>
                <textarea
                  className={`min-h-20 w-full rounded-md bg-transparent px-3 py-2 font-mono text-xs shadow-sm transition-all duration-200 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 ${
                    keyField.error
                      ? "border border-destructive focus-visible:ring-destructive/30"
                      : "border border-input focus-visible:ring-ring"
                  }`}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  value={form.key}
                  onChange={(e) => setForm({ ...form, key: e.target.value })}
                  onBlur={() => keyField.setTouched(true)}
                />
                {keyField.error && (
                  <p className="flex items-center gap-1 text-xs text-destructive">
                    <XCircle className="h-3 w-3 shrink-0" />
                    {keyField.error}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t("password")}</label>
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
            <Button onClick={submit} disabled={saving || !isAddValid}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingNode} onOpenChange={(o) => !o && setEditingNode(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{tCommon("edit")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormInput
                label={t("name")}
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                onBlur={() => editNameField.setTouched(true)}
                error={editNameField.error}
                required
              />
              <FormSelect
                label={t("type")}
                value={editForm.type}
                onValueChange={(v) => setEditForm({ ...editForm, type: v as "IRAN" | "FOREIGN" })}
                required
                valid={!!editForm.type}
              >
                <SelectItem value="IRAN">{t("iran")}</SelectItem>
                <SelectItem value="FOREIGN">{t("foreign")}</SelectItem>
              </FormSelect>
            </div>
            <FormInput
              label={t("host")}
              value={editForm.host}
              onChange={(e) => setEditForm({ ...editForm, host: e.target.value })}
              onBlur={() => editHostField.setTouched(true)}
              placeholder="203.0.113.10"
              error={editHostField.error}
              required
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormInput
                label={t("sshPort")}
                type="number"
                value={editForm.port}
                onChange={(e) => setEditForm({ ...editForm, port: Number(e.target.value) })}
              />
              <FormInput
                label={t("username")}
                value={editForm.username}
                onChange={(e) => setEditForm({ ...editForm, username: e.target.value })}
                onBlur={() => editUsernameField.setTouched(true)}
                error={editUsernameField.error}
                required
              />
            </div>
            <FormSelect
              label={t("authMethod")}
              value={editForm.authMethod}
              onValueChange={(v) => setEditForm({ ...editForm, authMethod: v })}
              required
              valid={!!editForm.authMethod}
            >
              <SelectItem value="key">{t("key")}</SelectItem>
              <SelectItem value="password">{t("password")}</SelectItem>
            </FormSelect>
            {editForm.authMethod === "key" ? (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  {t("key")}
                  <span className="ml-0.5 text-destructive">*</span>
                </label>
                <textarea
                  className={`min-h-20 w-full rounded-md bg-transparent px-3 py-2 font-mono text-xs shadow-sm transition-all duration-200 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 ${
                    editKeyField.error
                      ? "border border-destructive focus-visible:ring-destructive/30"
                      : "border border-input focus-visible:ring-ring"
                  }`}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  value={editForm.key}
                  onChange={(e) => setEditForm({ ...editForm, key: e.target.value })}
                  onBlur={() => editKeyField.setTouched(true)}
                />
                {editKeyField.error && (
                  <p className="flex items-center gap-1 text-xs text-destructive">
                    <XCircle className="h-3 w-3 shrink-0" />
                    {editKeyField.error}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <label className="text-sm font-medium">{t("password")}</label>
                <Input
                  type="password"
                  value={editForm.password}
                  onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingNode(null)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={editSubmit} disabled={saving || !isEditValid}>
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
