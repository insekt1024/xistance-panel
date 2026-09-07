"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Plus,
  Trash2,
  Wand2,
} from "lucide-react";
import { apiFetch } from "@/lib/client";
import type { TunnelConfig, TunnelMethod } from "@xistance/types";
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
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface WizardNode {
  id: string;
  name: string;
  type: "IRAN" | "FOREIGN";
  host: string;
}

const METHODS: TunnelMethod[] = ["BACKHAUL", "FRP", "GOST", "SSH", "PORT_FORWARD"];

function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(18))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground/70">{hint}</p> : null}
    </div>
  );
}

const STEPS = ["step1", "step2", "step3", "step4"] as const;

export function TunnelWizard({ nodes }: { nodes: WizardNode[] }) {
  const t = useTranslations("wizard");
  const tMethods = useTranslations("methods");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const [step, setStep] = React.useState(0);
  const [deploying, setDeploying] = React.useState(false);
  const [name, setName] = React.useState("");
  const [method, setMethod] = React.useState<TunnelMethod | null>(null);
  const [clientNodeId, setClientNodeId] = React.useState("");
  const [serverNodeId, setServerNodeId] = React.useState("");

  // Backhaul
  const [bh, setBh] = React.useState({
    transport: "tcp",
    listenPort: 5080,
    remoteHost: "",
    token: randomToken(),
    encryption: true,
    multiplexing: true,
    congestion: "cubic",
    portMap: [{ local: 80, remote: 8080 }],
  });
  // FRP
  const [frp, setFrp] = React.useState({
    bindPort: 7000,
    token: randomToken(),
    dashboard: { enabled: false, port: 17500, user: "admin", password: "" },
    proxies: [{ name: "web", type: "tcp", localPort: 80, remotePort: 8080 }],
  });
  // GOST / Paqet
  const [gost, setGost] = React.useState({
    bidirectional: false,
    direction: "IRAN",
    protocol: "tcp",
    listenPort: 8080,
    forwardHost: "",
    forwardPort: 80,
    remotePort: 5080,
  });
  // SSH
  const [ssh, setSsh] = React.useState({
    mode: "local",
    host: "",
    port: 22,
    username: "root",
    auth: "key",
    key: "",
    password: "",
    localPort: 8080,
    remoteHost: "127.0.0.1",
    remotePort: 80,
  });
  // Port forward rules
  const [rules, setRules] = React.useState([
    {
      name: "web",
      direction: "IRAN_TO_FOREIGN",
      protocol: "tcp",
      sourcePort: 8080,
      destHost: "",
      destPort: 80,
      enabled: true,
    },
  ]);

  const iranNodes = nodes.filter((n) => n.type === "IRAN");
  const foreignNodes = nodes.filter((n) => n.type === "FOREIGN");

  function buildConfig(): TunnelConfig | null {
    switch (method) {
      case "BACKHAUL":
        return {
          method: "BACKHAUL",
          backhaul: {
            role: "client",
            transport: bh.transport as "tcp" | "websocket" | "quic",
            listenAddress: "0.0.0.0",
            listenPort: bh.listenPort,
            remoteHost: bh.remoteHost,
            token: bh.token,
            encryption: bh.encryption,
            multiplexing: bh.multiplexing,
            congestion: bh.congestion as "cubic" | "new_reno" | "bbr",
            muxConcurrency: 64,
            heartbeat: 40,
            channelSize: 2048,
            bufferSize: 65536,
            portMap: bh.portMap,
          },
        };
      case "FRP":
        return {
          method: "FRP",
          frp: {
            bindPort: frp.bindPort,
            token: frp.token,
            dashboard: frp.dashboard,
            proxies: frp.proxies.map((p) => ({
              name: p.name,
              type: p.type as "tcp" | "udp" | "http" | "https" | "stcp" | "xtcp" | "sudp",
              localIP: "127.0.0.1",
              localPort: p.localPort,
              remotePort: p.remotePort,
              transport: { encryption: true, compression: true },
            })),
          },
        };
      case "GOST":
        return {
          method: "GOST",
          gost: {
            bidirectional: gost.bidirectional,
            direction: gost.direction as "IRAN" | "FOREIGN",
            protocol: gost.protocol as "tcp" | "udp",
            listenPort: gost.listenPort,
            forwardHost: gost.forwardHost,
            forwardPort: gost.forwardPort,
            remotePort: gost.remotePort,
            bufferSize: 65536,
            ttl: 60,
            udpDataBufferSize: 65536,
          },
        };
      case "SSH":
        return {
          method: "SSH",
          ssh: {
            mode: ssh.mode as "local" | "remote" | "dynamic",
            host: ssh.host,
            port: ssh.port,
            username: ssh.username,
            auth: ssh.auth as "key" | "password",
            key: ssh.auth === "key" ? ssh.key : undefined,
            password: ssh.auth === "password" ? ssh.password : undefined,
            localPort: ssh.localPort,
            remoteHost: ssh.remoteHost,
            remotePort: ssh.remotePort,
            localBindAddr: "127.0.0.1",
            remoteBindAddr: "0.0.0.0",
            dynamicBindAddr: "127.0.0.1",
            extraArgs: [],
          },
        };
      case "PORT_FORWARD":
        return {
          method: "PORT_FORWARD",
          portForwards: rules.map((r) => ({
            name: r.name,
            direction: r.direction as "IRAN_TO_FOREIGN" | "FOREIGN_TO_IRAN",
            protocol: r.protocol as "tcp" | "udp",
            sourcePort: r.sourcePort,
            destHost: r.destHost,
            destPort: r.destPort,
            enabled: r.enabled,
          })),
        };
      default:
        return null;
    }
  }

  function nextStep() {
    if (step === 0 && !method) {
      toast.error(t("invalidMethod"));
      return;
    }
    if (step === 1 && (!clientNodeId || !serverNodeId)) {
      toast.error(t("invalidNodes"));
      return;
    }
    if (step === 2 && !validateConfig()) return;
    setStep((s) => Math.min(s + 1, 3));
  }

  function isPort(n: number): boolean {
    return Number.isInteger(n) && n >= 1 && n <= 65535;
  }

  function validateConfig(): boolean {
    if (!name.trim()) {
      toast.error(t("nameMissing"));
      return false;
    }
    const fail = (msg: string) => {
      toast.error(msg);
      return false;
    };
    switch (method) {
      case "BACKHAUL": {
        if (!isPort(bh.listenPort)) return fail(t("invalidPort", { field: t("listenPort") }));
        if (!bh.remoteHost.trim()) return fail(t("fieldRequired", { field: t("remoteHost") }));
        for (let i = 0; i < bh.portMap.length; i++) {
          const m = bh.portMap[i];
          if (!isPort(m.local) || !isPort(m.remote)) {
            return fail(t("invalidPort", { field: `${t("portMap")} #${i + 1}` }));
          }
        }
        return true;
      }
      case "FRP": {
        if (frp.proxies.length === 0) {
          toast.error(t("emptyProxies"));
          return false;
        }
        if (!isPort(frp.bindPort)) return fail(t("invalidPort", { field: t("bindPort") }));
        if (frp.dashboard.enabled && frp.dashboard.port && !isPort(frp.dashboard.port)) {
          return fail(t("invalidPort", { field: t("dashboardPort") }));
        }
        for (let i = 0; i < frp.proxies.length; i++) {
          const p = frp.proxies[i];
          if (!p.name.trim()) return fail(t("fieldRequired", { field: `${t("proxies")} #${i + 1}` }));
          if (!isPort(p.localPort)) {
            return fail(t("invalidPort", { field: `${t("proxyLocalPort")} (#${i + 1})` }));
          }
          if (p.remotePort && !isPort(p.remotePort)) {
            return fail(t("invalidPort", { field: `${t("proxyRemotePort")} (#${i + 1})` }));
          }
        }
        return true;
      }
      case "GOST": {
        if (!isPort(gost.listenPort)) return fail(t("invalidPort", { field: t("listenPort") }));
        if (!gost.forwardHost.trim()) return fail(t("fieldRequired", { field: t("forwardHost") }));
        if (gost.forwardPort && !isPort(gost.forwardPort)) {
          return fail(t("invalidPort", { field: t("forwardPort") }));
        }
        if (gost.remotePort && !isPort(gost.remotePort)) {
          return fail(t("invalidPort", { field: t("remotePort") }));
        }
        return true;
      }
      case "SSH": {
        if (!ssh.host.trim() || !ssh.username.trim() || !isPort(ssh.localPort) || !isPort(ssh.remotePort)) {
          return fail(t("sshIncomplete"));
        }
        if (!isPort(ssh.port)) return fail(t("invalidPort", { field: t("remotePort") }));
        if (!ssh.remoteHost.trim()) return fail(t("fieldRequired", { field: t("remoteHostSvc") }));
        return true;
      }
      case "PORT_FORWARD": {
        if (rules.length === 0) {
          toast.error(t("emptyRules"));
          return false;
        }
        for (let i = 0; i < rules.length; i++) {
          const r = rules[i];
          if (!r.name.trim()) return fail(t("fieldRequired", { field: `${t("rules")} #${i + 1}` }));
          if (!r.destHost.trim()) {
            return fail(t("fieldRequired", { field: `${t("destHost")} (#${i + 1})` }));
          }
          if (!isPort(r.sourcePort) || !isPort(r.destPort)) {
            return fail(t("invalidPort", { field: `${t("sourcePort")}/${t("destPort")} (#${i + 1})` }));
          }
        }
        return true;
      }
      default:
        return true;
    }
  }

  async function deploy() {
    if (!method) return;
    const config = buildConfig();
    if (!config) return;
    setDeploying(true);
    const res = await apiFetch("/api/tunnels", {
      method: "POST",
      body: JSON.stringify({
        name,
        clientNodeId,
        serverNodeId,
        config,
        autostart: true,
      }),
    });
    setDeploying(false);
    if (res.ok) {
      toast.success(t("deploySuccess"));
      router.push("/tunnels");
      router.refresh();
    } else {
      toast.error((res.data as { error?: string })?.error ?? tCommon("error"));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        {STEPS.map((key, i) => (
          <div key={key} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => i < step && setStep(i)}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
                i === step
                  ? "border-primary bg-primary text-primary-foreground"
                  : i < step
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground",
              )}
            >
              {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </button>
            <span className={cn("text-sm", i === step ? "font-medium" : "text-muted-foreground")}>
              {t(key)}
            </span>
            {i < STEPS.length - 1 && <div className="h-px w-6 bg-border" />}
          </div>
        ))}
      </div>

      <Card className="p-6">
        {step === 0 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">{t("step1Title")}</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {METHODS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMethod(m)}
                  className={cn(
                    "rounded-lg border p-4 text-left transition-colors",
                    method === m
                      ? "border-primary bg-primary/5"
                      : "hover:border-primary/50",
                  )}
                >
                  <div className="font-semibold">{tMethods(m)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {tMethods(`${m}_DESC` as never)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">{t("step2Title")}</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("iranNode")}>
                <Select value={clientNodeId || undefined} onValueChange={setClientNodeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {iranNodes.map((n) => (
                      <SelectItem key={n.id} value={n.id}>
                        {n.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t("foreignNode")}>
                <Select value={serverNodeId || undefined} onValueChange={setServerNodeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    {foreignNodes.map((n) => (
                      <SelectItem key={n.id} value={n.id}>
                        {n.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </div>
        )}

        {step === 2 && method && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">{t("step3Title")}</h2>
            <Field label={t("name")}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("namePlaceholder")}
              />
            </Field>

            {method === "BACKHAUL" && (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label={t("listenPort")}>
                    <Input
                      type="number"
                      value={bh.listenPort}
                      onChange={(e) =>
                        setBh({ ...bh, listenPort: Number(e.target.value) })
                      }
                    />
                  </Field>
                  <Field label={t("remoteHost")} hint={t("remoteHostHint")} className="sm:col-span-2">
                    <Input
                      value={bh.remoteHost}
                      onChange={(e) => setBh({ ...bh, remoteHost: e.target.value })}
                      placeholder="203.0.113.10"
                    />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("transport")}>
                    <Select
                      value={bh.transport}
                      onValueChange={(v) => setBh({ ...bh, transport: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tcp">{t("tcp")}</SelectItem>
                        <SelectItem value="websocket">{t("websocket")}</SelectItem>
                        <SelectItem value="quic">{t("quic")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label={t("congestion")}>
                    <Select
                      value={bh.congestion}
                      onValueChange={(v) => setBh({ ...bh, congestion: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="cubic">{t("cubic")}</SelectItem>
                        <SelectItem value="new_reno">{t("newReno")}</SelectItem>
                        <SelectItem value="bbr">{t("bbr")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <Field label={t("token")} hint={t("tokenHint")}>
                  <div className="flex gap-2">
                    <Input value={bh.token} readOnly className="font-mono" />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setBh({ ...bh, token: randomToken() })}
                    >
                      <Wand2 className="h-4 w-4" />
                      {t("regenerate")}
                    </Button>
                  </div>
                </Field>
                <div className="flex flex-wrap gap-6">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={bh.encryption}
                      onCheckedChange={(c) => setBh({ ...bh, encryption: c })}
                    />
                    <Label>{t("encryption")}</Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={bh.multiplexing}
                      onCheckedChange={(c) => setBh({ ...bh, multiplexing: c })}
                    />
                    <Label>{t("multiplexing")}</Label>
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>{t("portMap")}</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setBh({
                          ...bh,
                          portMap: [...bh.portMap, { local: 0, remote: 0 }],
                        })
                      }
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("addPortMap")}
                    </Button>
                  </div>
                  {bh.portMap.map((m, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        type="number"
                        className="w-32"
                        placeholder={t("local")}
                        value={m.local || ""}
                        onChange={(e) => {
                          const next = [...bh.portMap];
                          next[i] = { ...m, local: Number(e.target.value) };
                          setBh({ ...bh, portMap: next });
                        }}
                      />
                      <span className="text-muted-foreground">→</span>
                      <Input
                        type="number"
                        className="w-32"
                        placeholder="remote"
                        value={m.remote || ""}
                        onChange={(e) => {
                          const next = [...bh.portMap];
                          next[i] = { ...m, remote: Number(e.target.value) };
                          setBh({ ...bh, portMap: next });
                        }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          setBh({
                            ...bh,
                            portMap: bh.portMap.filter((_, j) => j !== i),
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {method === "FRP" && (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("bindPort")}>
                    <Input
                      type="number"
                      value={frp.bindPort}
                      onChange={(e) =>
                        setFrp({ ...frp, bindPort: Number(e.target.value) })
                      }
                    />
                  </Field>
                  <Field label={t("token")} hint={t("tokenHint")}>
                    <div className="flex gap-2">
                      <Input value={frp.token} readOnly className="font-mono" />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => setFrp({ ...frp, token: randomToken() })}
                      >
                        <Wand2 className="h-4 w-4" />
                        {t("regenerate")}
                      </Button>
                    </div>
                  </Field>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={frp.dashboard.enabled}
                    onCheckedChange={(c) =>
                      setFrp({ ...frp, dashboard: { ...frp.dashboard, enabled: c } })
                    }
                  />
                  <Label>{t("dashboard")}</Label>
                </div>
                {frp.dashboard.enabled && (
                  <div className="grid gap-4 sm:grid-cols-3">
                    <Field label={t("dashboardPort")}>
                      <Input
                        type="number"
                        value={frp.dashboard.port}
                        onChange={(e) =>
                          setFrp({
                            ...frp,
                            dashboard: { ...frp.dashboard, port: Number(e.target.value) },
                          })
                        }
                      />
                    </Field>
                    <Field label={t("dashboardUser")}>
                      <Input
                        value={frp.dashboard.user}
                        onChange={(e) =>
                          setFrp({
                            ...frp,
                            dashboard: { ...frp.dashboard, user: e.target.value },
                          })
                        }
                      />
                    </Field>
                    <Field label={t("dashboardPassword")}>
                      <Input
                        value={frp.dashboard.password}
                        onChange={(e) =>
                          setFrp({
                            ...frp,
                            dashboard: { ...frp.dashboard, password: e.target.value },
                          })
                        }
                      />
                    </Field>
                  </div>
                )}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>{t("proxies")}</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setFrp({
                          ...frp,
                          proxies: [
                            ...frp.proxies,
                            { name: "p" + (frp.proxies.length + 1), type: "tcp", localPort: 0, remotePort: 0 },
                          ],
                        })
                      }
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("addProxy")}
                    </Button>
                  </div>
                  {frp.proxies.map((p, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Input
                        className="w-28"
                        value={p.name}
                        onChange={(e) => {
                          const next = [...frp.proxies];
                          next[i] = { ...p, name: e.target.value };
                          setFrp({ ...frp, proxies: next });
                        }}
                      />
                      <Select
                        value={p.type}
                        onValueChange={(v) => {
                          const next = [...frp.proxies];
                          next[i] = { ...p, type: v };
                          setFrp({ ...frp, proxies: next });
                        }}
                      >
                        <SelectTrigger className="w-24">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="tcp">tcp</SelectItem>
                          <SelectItem value="udp">udp</SelectItem>
                          <SelectItem value="http">http</SelectItem>
                          <SelectItem value="https">https</SelectItem>
                          <SelectItem value="stcp">stcp</SelectItem>
                          <SelectItem value="xtcp">xtcp</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        type="number"
                        className="w-28"
                        placeholder={t("proxyLocalPort")}
                        value={p.localPort || ""}
                        onChange={(e) => {
                          const next = [...frp.proxies];
                          next[i] = { ...p, localPort: Number(e.target.value) };
                          setFrp({ ...frp, proxies: next });
                        }}
                      />
                      <span className="text-muted-foreground">→</span>
                      <Input
                        type="number"
                        className="w-28"
                        placeholder={t("proxyRemotePort")}
                        value={p.remotePort || ""}
                        onChange={(e) => {
                          const next = [...frp.proxies];
                          next[i] = { ...p, remotePort: Number(e.target.value) };
                          setFrp({ ...frp, proxies: next });
                        }}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          setFrp({
                            ...frp,
                            proxies: frp.proxies.filter((_, j) => j !== i),
                          })
                        }
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {method === "GOST" && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Switch
                    checked={gost.bidirectional}
                    onCheckedChange={(c) => setGost({ ...gost, bidirectional: c })}
                  />
                  <Label>{t("bidirectional")}</Label>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label={t("direction")}>
                    <Select
                      value={gost.direction}
                      onValueChange={(v) => setGost({ ...gost, direction: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="IRAN">{t("iranNode")}</SelectItem>
                        <SelectItem value="FOREIGN">{t("foreignNode")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label={t("protocol")}>
                    <Select
                      value={gost.protocol}
                      onValueChange={(v) => setGost({ ...gost, protocol: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tcp">{t("tcp")}</SelectItem>
                        <SelectItem value="udp">UDP</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label={t("listenPort")}>
                    <Input
                      type="number"
                      value={gost.listenPort}
                      onChange={(e) =>
                        setGost({ ...gost, listenPort: Number(e.target.value) })
                      }
                    />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label={t("forwardHost")} hint={t("forwardHostHint")}>
                    <Input
                      value={gost.forwardHost}
                      onChange={(e) => setGost({ ...gost, forwardHost: e.target.value })}
                    />
                  </Field>
                  <Field label={t("forwardPort")}>
                    <Input
                      type="number"
                      value={gost.forwardPort}
                      onChange={(e) =>
                        setGost({ ...gost, forwardPort: Number(e.target.value) })
                      }
                    />
                  </Field>
                  <Field label={t("remotePort")}>
                    <Input
                      type="number"
                      value={gost.remotePort}
                      onChange={(e) =>
                        setGost({ ...gost, remotePort: Number(e.target.value) })
                      }
                    />
                  </Field>
                </div>
              </div>
            )}

            {method === "SSH" && (
              <div className="space-y-4">
                <Field label={t("sshMode")}>
                  <Select
                    value={ssh.mode}
                    onValueChange={(v) => setSsh({ ...ssh, mode: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="local">{t("modeLocal")}</SelectItem>
                      <SelectItem value="remote">{t("modeRemote")}</SelectItem>
                      <SelectItem value="dynamic">{t("modeDynamic")}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label={t("host")} className="sm:col-span-2">
                    <Input
                      value={ssh.host}
                      onChange={(e) => setSsh({ ...ssh, host: e.target.value })}
                      placeholder="203.0.113.10"
                    />
                  </Field>
                  <Field label={t("remotePort")}>
                    <Input
                      type="number"
                      value={ssh.port}
                      onChange={(e) => setSsh({ ...ssh, port: Number(e.target.value) })}
                    />
                  </Field>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label={t("username")}>
                    <Input
                      value={ssh.username}
                      onChange={(e) => setSsh({ ...ssh, username: e.target.value })}
                    />
                  </Field>
                  <Field label={t("auth")}>
                    <Select
                      value={ssh.auth}
                      onValueChange={(v) => setSsh({ ...ssh, auth: v })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="key">{t("authKey")}</SelectItem>
                        <SelectItem value="password">{t("authPassword")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                {ssh.auth === "key" ? (
                  <Field label={t("keyPem")}>
                    <textarea
                      className="min-h-24 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      value={ssh.key}
                      onChange={(e) => setSsh({ ...ssh, key: e.target.value })}
                    />
                  </Field>
                ) : (
                  <Field label={t("password")}>
                    <Input
                      type="password"
                      value={ssh.password}
                      onChange={(e) => setSsh({ ...ssh, password: e.target.value })}
                    />
                  </Field>
                )}
                {ssh.mode !== "dynamic" && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={ssh.mode === "remote" ? t("localPort") : t("remotePortSvc")}>
                      <Input
                        type="number"
                        value={ssh.mode === "remote" ? ssh.localPort : ssh.remotePort}
                        onChange={(e) =>
                          setSsh({
                            ...ssh,
                            [ssh.mode === "remote" ? "localPort" : "remotePort"]: Number(
                              e.target.value,
                            ),
                          })
                        }
                      />
                    </Field>
                    <Field label={t("remoteHostSvc")}>
                      <Input
                        value={ssh.remoteHost}
                        onChange={(e) => setSsh({ ...ssh, remoteHost: e.target.value })}
                      />
                    </Field>
                  </div>
                )}
              </div>
            )}

            {method === "PORT_FORWARD" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t("rules")}</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setRules([
                        ...rules,
                        {
                          name: "rule-" + (rules.length + 1),
                          direction: "IRAN_TO_FOREIGN",
                          protocol: "tcp",
                          sourcePort: 0,
                          destHost: "",
                          destPort: 0,
                          enabled: true,
                        },
                      ])
                    }
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("addRule")}
                  </Button>
                </div>
                {rules.map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
                    <Input
                      className="w-28"
                      value={r.name}
                      onChange={(e) => {
                        const next = [...rules];
                        next[i] = { ...r, name: e.target.value };
                        setRules(next);
                      }}
                    />
                    <Select
                      value={r.direction}
                      onValueChange={(v) => {
                        const next = [...rules];
                        next[i] = { ...r, direction: v };
                        setRules(next);
                      }}
                    >
                      <SelectTrigger className="w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="IRAN_TO_FOREIGN">{t("iranToForeign")}</SelectItem>
                        <SelectItem value="FOREIGN_TO_IRAN">{t("foreignToIran")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Select
                      value={r.protocol}
                      onValueChange={(v) => {
                        const next = [...rules];
                        next[i] = { ...r, protocol: v };
                        setRules(next);
                      }}
                    >
                      <SelectTrigger className="w-24">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tcp">TCP</SelectItem>
                        <SelectItem value="udp">UDP</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      className="w-24"
                      placeholder={t("sourcePort")}
                      value={r.sourcePort || ""}
                      onChange={(e) => {
                        const next = [...rules];
                        next[i] = { ...r, sourcePort: Number(e.target.value) };
                        setRules(next);
                      }}
                    />
                    <span className="text-muted-foreground">→</span>
                    <Input
                      className="w-32"
                      placeholder={t("destHost")}
                      value={r.destHost}
                      onChange={(e) => {
                        const next = [...rules];
                        next[i] = { ...r, destHost: e.target.value };
                        setRules(next);
                      }}
                    />
                    <Input
                      type="number"
                      className="w-24"
                      placeholder={t("destPort")}
                      value={r.destPort || ""}
                      onChange={(e) => {
                        const next = [...rules];
                        next[i] = { ...r, destPort: Number(e.target.value) };
                        setRules(next);
                      }}
                    />
                    <Switch
                      checked={r.enabled}
                      onCheckedChange={(c) => {
                        const next = [...rules];
                        next[i] = { ...r, enabled: c };
                        setRules(next);
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setRules(rules.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {step === 3 && method && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">{t("step4Title")}</h2>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t("name")}</dt>
                <dd className="font-medium">{name || "—"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Method</dt>
                <dd className="font-medium">{tMethods(method)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("iranNode")}</dt>
                <dd className="font-medium">
                  {nodes.find((n) => n.id === clientNodeId)?.name ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("foreignNode")}</dt>
                <dd className="font-medium">
                  {nodes.find((n) => n.id === serverNodeId)?.name ?? "—"}
                </dd>
              </div>
            </dl>
            <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-4 text-xs">
              {JSON.stringify(maskSecrets(buildConfig()), null, 2)}
            </pre>
            <p className="text-xs text-muted-foreground">{t("reviewNote")}</p>
          </div>
        )}
      </Card>

      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="outline"
          onClick={() => setStep((s) => Math.max(s - 1, 0))}
          disabled={step === 0 || deploying}
        >
          <ArrowLeft className="h-4 w-4" />
          {tCommon("back")}
        </Button>
        {step < 3 ? (
          <Button type="button" onClick={nextStep}>
            {tCommon("next")}
            <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button type="button" onClick={deploy} disabled={deploying}>
            {deploying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            {deploying ? t("deploying") : t("deploy")}
          </Button>
        )}
      </div>
    </div>
  );
}

function maskSecrets(config: TunnelConfig | null): unknown {
  if (!config) return config;
  const copy = JSON.parse(JSON.stringify(config)) as Record<string, Record<string, unknown>>;
  const masked = "••••••••";
  if (copy.backhaul) {
    copy.backhaul.token = masked;
  }
  if (copy.frp) {
    copy.frp.token = masked;
    const dash = copy.frp.dashboard as Record<string, unknown> | undefined;
    if (dash?.password) dash.password = masked;
  }
  if (copy.ssh) {
    if (copy.ssh.key) copy.ssh.key = masked;
    if (copy.ssh.password) copy.ssh.password = masked;
  }
  return copy;
}
