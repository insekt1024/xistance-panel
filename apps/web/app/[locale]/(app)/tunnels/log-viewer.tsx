"use client";

import * as React from "react";
import { X, Search, Pause, Play, Trash2 } from "lucide-react";
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
  const [paused, setPaused] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [levelFilter, setLevelFilter] = React.useState<string>("all");
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const buf = React.useRef<string[]>([]);
  const pausedBuf = React.useRef<string[]>([]);
  // Whether the reader is pinned near the bottom; only then do we auto-scroll.
  const stickRef = React.useRef(true);
  // onClose is an inline fn at the call site — keep it in a ref so effects
  // below don't re-subscribe on every parent render.
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  const isStderr = (line: string) =>
    line.toLowerCase().includes("error") || line.toLowerCase().includes("stderr");

  const filteredLines = React.useMemo(() => {
    let result = lines;
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l) => l.toLowerCase().includes(q));
    }
    if (levelFilter === "stderr") {
      result = result.filter((l) => isStderr(l));
    } else if (levelFilter === "stdout") {
      result = result.filter((l) => !isStderr(l));
    }
    return result;
  }, [lines, search, levelFilter]);

  const pausedRef = React.useRef(paused);
  pausedRef.current = paused;

  // Track "near bottom" on the Radix viewport (scroll events don't bubble, so
  // listen natively on the viewport element itself).
  React.useEffect(() => {
    const viewport = scrollRef.current?.querySelector("[data-radix-scroll-area-viewport]");
    if (!viewport) return;
    const onScroll = () => {
      const el = viewport as HTMLElement;
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, []);

  React.useEffect(() => {
    let disposed = false;
    buf.current = [];
    pausedBuf.current = [];

    void fetch(`/api/tunnels/${tunnelId}/logs`)
      .then((r) => r.json())
      .then((d) => {
        if (disposed) return;
        buf.current = ((d.lines ?? []) as string[]).slice(-1000);
        if (!pausedRef.current) setLines([...buf.current]);
      })
      .catch(() => {});

    const es = new EventSource(`/api/tunnels/${tunnelId}/events`);
    let rafId: number | null = null;

    const flushBuffer = () => {
      if (pausedRef.current || disposed) {
        rafId = null;
        return;
      }
      if (buf.current.length > 0) {
        setLines([...buf.current]);
      }
      rafId = null;
    };

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as { type?: string; line?: string };
        if (data.type === "log" && data.line) {
          if (pausedRef.current) {
            pausedBuf.current.push(data.line);
            if (pausedBuf.current.length > 1000) pausedBuf.current = pausedBuf.current.slice(-1000);
          } else {
            buf.current.push(data.line);
            if (buf.current.length > 1000) buf.current = buf.current.slice(-1000);
            if (rafId === null) {
              rafId = requestAnimationFrame(flushBuffer);
            }
          }
        }
      } catch {
        /* ignore malformed */
      }
    };

    return () => {
      disposed = true;
      es.close();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [tunnelId]);

  React.useEffect(() => {
    if (!paused && stickRef.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [filteredLines, paused]);

  const togglePause = React.useCallback(() => {
    setPaused((p) => {
      if (!p) {
        pausedBuf.current = [];
      } else {
        buf.current.push(...pausedBuf.current);
        if (buf.current.length > 1000) buf.current = buf.current.slice(-1000);
        pausedBuf.current = [];
        setLines([...buf.current]);
      }
      return !p;
    });
  }, []);

  const clearLogs = React.useCallback(() => {
    buf.current = [];
    pausedBuf.current = [];
    setLines([]);
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  return (
    <div
      className="animate-fade-in fixed inset-0 z-50 flex flex-col bg-black/70 p-2 backdrop-blur-sm sm:p-6"
      onClick={onClose}
    >
      <div
        className="animate-scale-in flex flex-1 flex-col overflow-hidden rounded-lg border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-2">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              {connected && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
              )}
              <span
                className={cn(
                  "relative inline-flex h-2 w-2 rounded-full transition-colors",
                  connected ? "bg-success" : "bg-destructive",
                )}
              />
            </span>
            <span className="text-sm font-medium">{t("logViewer")}</span>
            <span className="text-xs text-muted-foreground">
              {filteredLines.length}/{lines.length}
            </span>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close log viewer">
            <X className="h-4 w-4 transition-transform duration-200 hover:rotate-90" />
          </Button>
        </div>
        <div className="flex items-center gap-2 border-b px-4 py-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              placeholder={t("logSearchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-full rounded-md border bg-background pl-8 pr-2 text-xs outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="all">{t("logLevelAll")}</option>
            <option value="stdout">{t("logLevelStdout")}</option>
            <option value="stderr">{t("logLevelStderr")}</option>
          </select>
          <Button
            variant={paused ? "default" : "outline"}
            size="icon"
            className="h-8 w-8"
            onClick={togglePause}
            aria-label={paused ? "Resume streaming" : "Pause streaming"}
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={clearLogs}
            aria-label="Clear logs"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        <ScrollArea className="flex-1 bg-black font-mono text-xs text-zinc-100 scrollbar-thin" ref={scrollRef}>
          <div className="p-4">
            {filteredLines.length === 0 && (
              <p className="animate-pulse text-zinc-500">
                {lines.length === 0 ? t("logWaiting") : t("logNoMatch")}
              </p>
            )}
            {filteredLines.map((line, i) => (
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
