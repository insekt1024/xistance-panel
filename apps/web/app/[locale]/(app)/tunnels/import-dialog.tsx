"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { toast } from "sonner";
import { Upload, FileJson, Loader2 } from "lucide-react";
import { apiFetch } from "@/lib/client";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export interface ImportNode {
  id: string;
  name: string;
  type: string;
}

interface ImportedConfig {
  name?: string;
  method?: string;
  config?: unknown;
}

const KNOWN_METHODS = ["BACKHAUL", "FRP", "GOST", "SSH", "PORT_FORWARD"];

// The server validates `config` against a discriminated union on `method`,
// so derive the method from the config shape itself (the authoritative source).
function deriveMethod(cfg: unknown): string | null {
  if (!cfg || typeof cfg !== "object") return null;
  const c = cfg as Record<string, unknown>;
  for (const k of ["backhaul", "frp", "gost", "ssh"]) {
    if (c[k] !== undefined) return k.toUpperCase();
  }
  if (Array.isArray(c.portForwards)) return "PORT_FORWARD";
  return null;
}

export function ImportDialog({ nodes }: { nodes: ImportNode[] }) {
  const t = useTranslations("tunnels");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const [open, setOpen] = React.useState(false);
  const [jsonText, setJsonText] = React.useState("");
  const [parsed, setParsed] = React.useState<ImportedConfig | null>(null);
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [tunnelName, setTunnelName] = React.useState("");
  const [clientNodeId, setClientNodeId] = React.useState("");
  const [serverNodeId, setServerNodeId] = React.useState("");
  const [autostart, setAutostart] = React.useState(true);
  const [deploying, setDeploying] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const iranNodes = nodes.filter((n) => n.type === "IRAN");
  const foreignNodes = nodes.filter((n) => n.type === "FOREIGN");

  function reset() {
    setJsonText("");
    setParsed(null);
    setParseError(null);
    setTunnelName("");
    setClientNodeId("");
    setServerNodeId("");
    setAutostart(true);
  }

  function handleOpenChange(o: boolean) {
    setOpen(o);
    if (!o) reset();
  }

  function tryParse(text: string) {
    setJsonText(text);
    setParseError(null);
    setParsed(null);
    if (!text.trim()) return;
    try {
      const obj = JSON.parse(text) as ImportedConfig;
      if (!obj.method || !obj.config) {
        setParseError("Invalid config: missing 'method' or 'config' fields");
        return;
      }
      const cfg = obj.config as Record<string, unknown>;
      if (obj.method === "PORT_FORWARD" && !Array.isArray(cfg.portForwards)) {
        setParseError("Invalid PORT_FORWARD config: missing 'portForwards' array");
        return;
      }
      const methodKey = obj.method.toLowerCase().replace("_", "");
      if (cfg[methodKey] === undefined && obj.method !== "PORT_FORWARD") {
        setParseError(`Invalid ${obj.method} config: missing '${obj.method.toLowerCase()}' key`);
        return;
      }
      setParsed(obj);
      setTunnelName(obj.name ?? "");
    } catch {
      setParseError("Invalid JSON");
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      tryParse(reader.result as string);
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function handlePaste() {
    navigator.clipboard.readText().then(tryParse).catch(() => {});
  }

  async function deploy() {
    if (!parsed || !clientNodeId || !serverNodeId || !tunnelName.trim()) return;
    const method =
      deriveMethod(parsed.config) ??
      (parsed.method && KNOWN_METHODS.includes(parsed.method) ? parsed.method : null);
    if (!method) {
      toast.error(t("importUnknownMethod"));
      return;
    }
    setDeploying(true);
    const res = await apiFetch("/api/tunnels", {
      method: "POST",
      body: JSON.stringify({
        name: tunnelName.trim(),
        clientNodeId,
        serverNodeId,
        method,
        config: { ...(parsed.config as Record<string, unknown>), method },
        autostart,
      }),
    });
    setDeploying(false);
    if (res.ok) {
      toast.success(t("imported"));
      setOpen(false);
      reset();
      router.refresh();
    } else {
      toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload className="h-4 w-4" />
          {t("import")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("importConfig")}</DialogTitle>
          <DialogDescription>{t("importDesc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("jsonConfig")}</Label>
            <div className="flex gap-2">
              <textarea
                className="min-h-40 flex-1 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder='{"name":"My Tunnel","method":"FRP","config":{...}}'
                value={jsonText}
                onChange={(e) => tryParse(e.target.value)}
              />
            </div>
            {parseError && (
              <p className="text-xs text-destructive">{parseError}</p>
            )}
          </div>

          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <FileJson className="h-4 w-4" />
              {t("uploadFile")}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handlePaste}>
              <Upload className="h-4 w-4" />
              {t("pasteFromClipboard")}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".json"
              className="hidden"
              onChange={handleFile}
            />
          </div>

          {parsed && (
            <div className="space-y-3 rounded-md border bg-muted/30 p-4">
              <p className="text-xs text-muted-foreground">
                {t("detectedMethod")}: <span className="font-mono font-medium">{parsed.method}</span>
              </p>
              <div className="space-y-2">
                <Label>{t("name")}</Label>
                <Input
                  value={tunnelName}
                  onChange={(e) => setTunnelName(e.target.value)}
                  placeholder={t("namePlaceholder")}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t("iranNode")}</Label>
                  <Select value={clientNodeId || undefined} onValueChange={setClientNodeId}>
                    <SelectTrigger>
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      {iranNodes.map((n) => (
                        <SelectItem key={n.id} value={n.id}>{n.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("foreignNode")}</Label>
                  <Select value={serverNodeId || undefined} onValueChange={setServerNodeId}>
                    <SelectTrigger>
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      {foreignNodes.map((n) => (
                        <SelectItem key={n.id} value={n.id}>{n.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="import-autostart"
                  checked={autostart}
                  onChange={(e) => setAutostart(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <Label htmlFor="import-autostart">{t("autostart")}</Label>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button
            disabled={!parsed || !clientNodeId || !serverNodeId || !tunnelName.trim() || deploying}
            onClick={deploy}
          >
            {deploying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {t("import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
