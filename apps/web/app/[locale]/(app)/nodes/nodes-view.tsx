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
import { StateBlock } from "@/components/state-block";

export interface NodeRow {
  id: string;
  name: string;
  type: "IRAN" | "FOREIGN";
  host: string;
  sshPort: number;
  sshUser: string;
  authMethod: string;
  status: string;
  hasKey: boolean;
  hasPassword: boolean;
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
  // Lenient on purpose: IPv6 (::1), IDNs and plain hostnames must all pass;
  // the server schema (z.string().min(1)) is the authority.
  const hostField = useFieldValidation(form.host, {
    required: true,
    validate: (v) => {
      if (!v.trim()) return undefined;
      if (/[\s\x00-\x1f\x7f]/.test(v)) return "Invalid hostname or IP";
      return undefined;
    },
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
    validate: (v) => {
      if (!v.trim()) return undefined;
      if (/[\s\x00-\x1f\x7f]/.test(v)) return "Invalid hostname or IP";
      return undefined;
    },
  });
  const editUsernameField = useFieldValidation(editForm.username, { required: true, minLength: 1 });
  // Edit mode keeps the stored key when the field is left empty, so unlike the
  // create form the key is optional here (blank secrets are omitted on submit).
  const editKeyField = useFieldValidation(editForm.key, {});

  // Key is optional when editing (empty = keep stored key), so it must not
  // gate the save button.
  const isEditValid =
    editNameField.valid && editHostField.valid && editUsernameField.valid;

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
    // Blank secrets mean "keep existing" — omit them so stored values survive.
    const payload: Record<string, unknown> = { ...editForm };
    if (!editForm.key.trim()) delete payload.key;
    if (!editForm.password.trim()) delete payload.password;
    const res = await apiFetch(`/api/nodes/${editingNode.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
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
        <StateBlock
          kind="empty"
          message={t("empty")}
          description={t("emptyHint")}
          action={
            <Button size="sm" onClick={() => setDialogOpen(true)}>
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
              <TableHead className="whitespace-nowrap">{t("host")}</TableHead>
              <TableHead className="whitespace-nowrap">{t("sshPort")}</TableHead>
              <TableHead className="whitespace-nowrap">{t("authMethod")}</TableHead>
              <TableHead className="whitespace-nowrap">{t("status")}</TableHead>
              <TableHead className="text-end">{tCommon("actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {nodes.map((n, i) => (
              <TableRow key={n.id} className="animate-fade-in-up" style={{ "--stagger": Math.min(i, 10) } as React.CSSProperties}>
                {/* A node's name is an IDENTIFIER. Measured with a realistic
                    43-character name it wrapped to SIX lines inside an 82px
                    column and overflowed by up to 69px. The table wrapper
                    already scrolls horizontally, so `whitespace-nowrap` lets the
                    table scroll rather than shredding the name.
                    Found by test-dashboard-legibility.ts. */}
                <TableCell className="whitespace-nowrap font-medium">{n.name}</TableCell>
                <TableCell>
                  {n.type === "IRAN" ? t("iran") : t("foreign")}
                </TableCell>
                {/* Same reasoning as the name: a FQDN is not prose. */}
                <TableCell className="whitespace-nowrap font-mono text-xs">{n.host}</TableCell>
                {/* An identifier in a table cell. The wrapper already scrolls horizontally, so `whitespace-nowrap` lets the TABLE scroll rather than wrapping the value across several lines in a narrow column. Measured with realistic long values by test-dashboard-legibility.ts. */}
                <TableCell className="whitespace-nowrap tabular-nums">{n.sshPort}</TableCell>
                {/* An emoji and a word in one text node give the cell TWO line
                    boxes -- measured at 48px of content inside an 18px box. The
                    cell is now one line, and the emoji sits in its own inline
                    span so it cannot set the box height. The glyph is
                    aria-hidden because the word beside it already names it.
                    Found by test-dashboard-legibility.ts. */}
                <TableCell className="whitespace-nowrap">
                  {n.authMethod === "key" ? (
                    n.hasKey ? (
                      <span className="inline-flex items-center gap-1 align-middle">
                        <span aria-hidden="true">🔑</span>
                        <span>key</span>
                      </span>
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
                <TableCell className="text-end">
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
        {/* Stable hook for the browser suite. Locating this dialog by its
            translated title broke when the copy changed, and the test then
            reported "the form is empty" while talking to a page with no form. */}
        <DialogContent data-testid="node-create-dialog">
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
                {/* Programmatic association. This control had a <label> with no
                    htmlFor, so it had NO accessible name at all -- WCAG 2.2 AA
                    1.3.1, 3.3.2 and 4.1.2 all fail without it. */}
                <label className="text-sm font-medium" htmlFor="node-key-input">
                  {t("key")}
                  <span className="ms-0.5 text-destructive">*</span>
                </label>
                <textarea
                  id="node-key-input"
                  aria-required="true"
                  aria-invalid={keyField.error ? true : undefined}
                  aria-describedby={keyField.error ? "node-key-input-error" : undefined}
                  className={`min-h-20 w-full rounded-md bg-transparent px-3 py-2 font-mono text-xs
                    keyField.error
                      ? "border border-destructive focus-visible:ring-destructive/30"
                      : "border border-input focus-visible:ring-ring"
                  `}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  value={form.key}
                  onChange={(e) => setForm({ ...form, key: e.target.value })}
                  onBlur={() => keyField.setTouched(true)}
                />
                {keyField.error && (
                  <p id="node-key-input-error" role="alert" className="flex items-center gap-1 text-xs text-destructive">
                    <XCircle className="h-3 w-3 shrink-0" />
                    {keyField.error}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                {/* Same fix as the key field: the label needs htmlFor. */}
                <label className="text-sm font-medium" htmlFor="node-password-input">
                  {t("password")}
                </label>
                <Input
                  id="node-password-input"
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
                <label className="text-sm font-medium" htmlFor="edit-node-key-input">
                  {t("key")}
                </label>
                <textarea
                  id="edit-node-key-input"
                  aria-invalid={editKeyField.error ? true : undefined}
                  aria-describedby={editKeyField.error ? "edit-node-key-input-error" : undefined}
                  className={`min-h-20 w-full rounded-md bg-transparent px-3 py-2 font-mono text-xs
                    editKeyField.error
                      ? "border border-destructive focus-visible:ring-destructive/30"
                      : "border border-input focus-visible:ring-ring"
                  `}
                  placeholder={t("keepExistingKey")}
                  value={editForm.key}
                  onChange={(e) => setEditForm({ ...editForm, key: e.target.value })}
                  onBlur={() => editKeyField.setTouched(true)}
                />
                {editKeyField.error && (
                  <p id="edit-node-key-input-error" role="alert" className="flex items-center gap-1 text-xs text-destructive">
                    <XCircle className="h-3 w-3 shrink-0" />
                    {editKeyField.error}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="edit-node-password-input">{t("password")}</label>
                <Input
                  id="edit-node-password-input"
                  type="password"
                  value={editForm.password}
                  placeholder={t("keepExistingKey")}
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