"use client";

/**
 * Tunnel diagnostic and recovery panel (TASK-36).
 *
 * The server already had everything this flow needs -- `/diagnostics` returns a
 * sanitised `TunnelDiagnostic` (state, errorCategory, summary, retryCount,
 * nextAction, exhausted) and `/actions` performs start/stop/restart. What was
 * missing was the UI: nothing in the app ever called `/diagnostics`, so an
 * operator whose tunnel was degraded or had exhausted its retries had no way to
 * see why or what to do about it. The AC for this task are UI-level, so they are
 * asserted in a real browser (scripts/test-smoke-tunnel-diagnostics.ts).
 *
 * Rules this component enforces, each with a browser assertion behind it:
 *
 *   - NO OPTIMISTIC STATE. The displayed state is whatever the server last
 *     reported. Clicking "restart" does not paint the badge as running; the
 *     badge changes only after the action resolves and the panel refetches. The
 *     task's technicalNotes are explicit about this, and an optimistic badge is
 *     how a row ends up claiming `running` while the tunnel is degraded.
 *   - Every action control is disabled while a request is in flight, so a
 *     double-click cannot fire two restarts.
 *   - The failure path ANNOUNCES, so a screen-reader user learns the restart was
 *     rejected rather than just seeing the page go quiet.
 *   - The suggested recovery action is derived from the diagnostic, and the raw
 *     `summary` is rendered as a text node, never as markup.
 */

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, RotateCcw, Wrench } from "lucide-react";

import { apiFetch } from "@/lib/client";
import { StateBlock } from "@/components/state-block";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Mirrors DiagnosticErrorCategory in packages/tunnel-core/src/diagnostics.ts. */
const ERROR_CATEGORIES = [
  "unreachable", "permission", "resource", "missing_binary",
  "configuration", "authentication", "timeout", "unknown",
] as const;

/** Mirrors RecoveryAction in the same module. */
const RECOVERY_ACTIONS = ["none", "wait", "retry", "restart", "recheck", "fix_config"] as const;

interface TunnelDiagnostic {
  state: string;
  lastTransitionAt: number;
  errorCategory: string | null;
  summary: string;
  retryCount: number;
  nextAction: string;
  exhausted: boolean;
}

type Action = "start" | "stop" | "restart";

function isCategory(v: string | null): v is (typeof ERROR_CATEGORIES)[number] {
  return v != null && (ERROR_CATEGORIES as readonly string[]).includes(v);
}
function isRecovery(v: string): v is (typeof RECOVERY_ACTIONS)[number] {
  return (RECOVERY_ACTIONS as readonly string[]).includes(v);
}

/** States that mean "this tunnel is not doing what you asked". */
const DEGRADED: readonly string[] = ["degraded", "error", "starting", "stopping", "failed"];

export function TunnelDiagnosticsPanel({
  tunnelId,
  className,
  onRecovered,
}: {
  tunnelId: string;
  className?: string;
  /** Called after a confirmed server-side recovery, so a list row can re-read truth. */
  onRecovered?: () => void;
}) {
  const t = useTranslations("diagnostics");
  const tTunnels = useTranslations("tunnels");
  const locale = useLocale();

  const [diag, setDiag] = useState<TunnelDiagnostic | null>(null);
  const [history, setHistory] = useState<TunnelDiagnostic[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState<Action | null>(null);
  /** Outcome of the last action, as a text label -- never a thrown Error's message. */
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ latest: TunnelDiagnostic | null; history: TunnelDiagnostic[] }>(
        `/api/tunnels/${tunnelId}/diagnostics`,
      );
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      setDiag(res.data?.latest ?? null);
      setHistory(Array.isArray(res.data?.history) ? res.data.history : []);
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [tunnelId]);

  // Load on mount, and again whenever the tunnel changes. The microtask deferral
  // keeps setState out of the effect body's first tick, which would otherwise be
  // a cascading render (and is rejected by react-hooks/set-state-in-effect).
  useEffect(() => {
    let live = true;
    void Promise.resolve().then(() => {
      if (live) void load();
    });
    return () => {
      // A refetch after unmount would setState on a dead component.
      live = false;
    };
  }, [load]);

  /** Localized verb for the action, so the outcome line is not a bare English word in fa. */
  const tCommonAction = useCallback(
    (a: Action) => (a === "start" ? tTunnels("started") : a === "stop" ? tTunnels("stoppedMsg") : tTunnels("restarted")),
    [tTunnels],
  );

  const runAction = useCallback(
    async (action: Action) => {
      // Guard on the client too: the control is disabled while pending, but a
      // keyboard repeat or a second component instance must not double-fire.
      if (pending) return;
      setPending(action);
      setOutcome(null);
      try {
        const res = await apiFetch(`/api/tunnels/${tunnelId}/actions`, {
          method: "POST",
          body: JSON.stringify({ action }),
        });
        if (!res.ok) {
          setOutcome({ ok: false, text: t("actionFailed") });
          return;
        }
        setOutcome({ ok: true, text: t("actionSucceeded", { action: tCommonAction(action) }) });
        // Re-read the server's truth. The displayed state changes here and
        // nowhere else -- never optimistically at the click.
        await load();
        onRecovered?.();
      } catch {
        setOutcome({ ok: false, text: t("actionFailed") });
      } finally {
        setPending(null);
      }
    },
    [pending, tunnelId, load, onRecovered, t, tCommonAction],
  );

  if (loading) {
    return (
      <StateBlock
        kind="loading"
        message={t("loadingPanel")}
        className={className}
        action={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden className="me-2 size-4" />
            {t("refresh")}
          </Button>
        }
      />
    );
  }

  if (loadError) {
    return (
      <StateBlock
        kind="error"
        message={t("loadFailed")}
        action={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw aria-hidden className="me-2 size-4" />
            {t("retryLoad")}
          </Button>
        }
        className={className}
      />
    );
  }

  if (!diag) {
    return (
      <StateBlock
        kind="empty"
        message={t("noDiagnostics")}
        description={t("noDiagnosticsHint")}
        className={className}
        action={
          <Button variant="outline" size="sm" onClick={() => void runAction("restart")} disabled={pending !== null}>
            {pending ? <Loader2 aria-hidden className="me-2 size-4 animate-spin" /> : <RotateCcw aria-hidden className="me-2 size-4" />}
            {t("action.restart")}
          </Button>
        }
      />
    );
  }

  const degraded = DEGRADED.includes(diag.state);
  const suggested = isRecovery(diag.nextAction) ? diag.nextAction : "none";
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <section
      data-tunnel-diagnostics={tunnelId}
      data-state={diag.state}
      data-degraded={degraded ? "true" : "false"}
      data-exhausted={diag.exhausted ? "true" : "false"}
      aria-labelledby={`diag-title-${tunnelId}`}
      className={cn("flex flex-col gap-4", className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`diag-title-${tunnelId}`} className="text-sm font-semibold">
          {t("title")}
        </h3>
        <div className="flex items-center gap-2">
          <StatusBadge status={diag.state} />
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={pending !== null} data-action="refresh">
            <RefreshCw aria-hidden className="size-4" />
            <span className="sr-only sm:not-sr-only ms-2">{t("refresh")}</span>
          </Button>
        </div>
      </div>

      {/* Announce the action outcome, not just the state change: a screen-reader
          user needs to know the restart FAILED, not that the page went quiet. */}
      <div role="status" aria-live="polite" data-testid="diag-outcome" className="min-h-0">
        {outcome ? (
          <p
            data-outcome={outcome.ok ? "success" : "failure"}
            className={cn("flex items-center gap-2 text-sm", outcome.ok ? "text-success" : "text-destructive")}
          >
            {outcome.ok ? <CheckCircle2 aria-hidden className="size-4" /> : <AlertTriangle aria-hidden className="size-4" />}
            {outcome.text}
          </p>
        ) : null}
      </div>

      {diag.exhausted ? (
        <p
          data-testid="diag-exhausted"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            {t("exhausted")} ({t("retryCount")}: {diag.retryCount})
          </span>
        </p>
      ) : null}

      <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2" data-testid="diag-fields">
        <div>
          <dt className="text-xs text-muted-foreground">{t("processState")}</dt>
          <dd data-field="state">{diag.state}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("lastTransition")}</dt>
          <dd data-field="lastTransition">{dateFmt.format(new Date(diag.lastTransitionAt))}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("retryCount")}</dt>
          <dd data-field="retryCount">{diag.retryCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("errorCategory")}</dt>
          <dd data-field="errorCategory">
            {isCategory(diag.errorCategory) ? t(`category.${diag.errorCategory}`) : t("noErrors")}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs text-muted-foreground">{t("nextAction")}</dt>
          <dd data-field="nextAction" className="flex items-center gap-2">
            {suggested === "fix_config" ? <Wrench aria-hidden className="size-4 text-muted-foreground" /> : null}
            {t(`action.${suggested}`)}
          </dd>
        </div>
        {diag.summary ? (
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">{t("summary")}</dt>
            {/* Server-redacted text. Rendered as a text node, never as markup. */}
            <dd data-field="summary" className="whitespace-pre-wrap break-words font-mono text-xs">
              {diag.summary}
            </dd>
          </div>
        ) : null}
      </dl>

      <div className="flex flex-wrap items-center gap-2" data-testid="diag-actions">
        <Button
          size="sm"
          onClick={() => void runAction("restart")}
          disabled={pending !== null}
          data-action="restart"
        >
          {pending === "restart" ? <Loader2 aria-hidden className="me-2 size-4 animate-spin" /> : <RotateCcw aria-hidden className="me-2 size-4" />}
          {t("action.restart")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void runAction("start")}
          disabled={pending !== null}
          data-action="start"
        >
          {pending === "start" ? <Loader2 aria-hidden className="me-2 size-4 animate-spin" /> : null}
          {t("action.retry")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void runAction("stop")}
          disabled={pending !== null}
          data-action="stop"
        >
          {pending === "stop" ? <Loader2 aria-hidden className="me-2 size-4 animate-spin" /> : null}
          {tTunnels("stoppedMsg")}
        </Button>
      </div>

      {history.length > 0 ? (
        <details className="rounded-md border border-border p-3" data-testid="diag-history">
          <summary className="cursor-pointer text-sm font-medium">
            {t("history")} ({history.length})
          </summary>
          <ol className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
            {history.slice(0, 10).map((h, i) => (
              <li key={`${h.lastTransitionAt}-${i}`} className="flex flex-wrap gap-x-2">
                <span>{dateFmt.format(new Date(h.lastTransitionAt))}</span>
                <span>{h.state}</span>
                {h.errorCategory ? <span>{isCategory(h.errorCategory) ? t(`category.${h.errorCategory}`) : h.errorCategory}</span> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

export default TunnelDiagnosticsPanel;
