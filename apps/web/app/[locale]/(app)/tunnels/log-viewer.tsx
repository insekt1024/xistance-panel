"use client";

import * as React from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function LogViewer({
  tunnelId,
  onClose,
}: {
  tunnelId: string;
  onClose: () => void;
}) {
  const t = useTranslations("tunnels");
  const [lines, setLines] = React.useState<string[]>([]);
  const [connected, setConnected] = React.useState(false);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const buf = React.useRef<string[]>([]);

  React.useEffect(() => {
    let disposed = false;
    buf.current = [];

    void fetch(`/api/tunnels/${tunnelId}/logs`)
      .then((r) => r.json())
      .then((d) => {
        if (disposed) return;
        buf.current = (d.lines ?? []) as string[];
        setLines([...buf.current]);
      })
      .catch(() => {});

    const es = new EventSource(`/api/tunnels/${tunnelId}/events`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as { type?: string; line?: string };
        if (data.type === "log" && data.line) {
          buf.current.push(data.line);
          if (buf.current.length > 1000) buf.current.shift();
          setLines([...buf.current]);
        }
      } catch {
        /* ignore malformed */
      }
    };

    return () => {
      disposed = true;
      es.close();
    };
  }, [tunnelId]);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/70 p-2 backdrop-blur-sm sm:p-6">
      <div className="flex flex-1 flex-col overflow-hidden rounded-lg border bg-background">
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                connected ? "bg-success" : "bg-destructive",
              )}
            />
            <span className="text-sm font-medium">{t("logViewer")}</span>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <ScrollArea className="flex-1 bg-black font-mono text-xs text-zinc-100">
          <div className="p-4">
            {lines.length === 0 && (
              <p className="text-zinc-500">Waiting for output…</p>
            )}
            {lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
