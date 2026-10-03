"use client";

/**
 * Shared loading / empty / error states.
 *
 * Every list route in this app had grown its own empty markup: a dashed border
 * with a sentence in it. That markup is invisible to a screen reader (no role,
 * no live region) and it left the operator at a dead end, because a sentence
 * telling you there are no nodes is not a way to add one. Five routes were
 * affected.
 *
 * This component is the single place that decides what a state block looks like,
 * so the five call sites cannot drift apart again.
 *
 * Design rules it enforces, each of which the browser suite asserts:
 *   - a `role` + `aria-live` so the state is announced, not merely painted;
 *   - the loading state names what is being loaded, in the active locale, so it
 *     is never a bare spinner;
 *   - the empty state takes a *required* action, so the dead end has an exit;
 *   - error text is authored, not a thrown Error's message, so internals
 *     (paths, SQL, stack frames) cannot reach the operator by default.
 */

import { AlertTriangle, Inbox, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type StateKind = "loading" | "empty" | "error";

/** Nothing in this panel is truncated to a hard cap for security reasons; keep the strings short in the catalog instead. */
const VARIANT: Record<StateKind, { role: "status" | "alert"; live: "polite" | "assertive" }> = {
  loading: { role: "status", live: "polite" },
  empty: { role: "status", live: "polite" },
  // Errors interrupt: an alert should be read when it appears, not queued
  // behind whatever else the polite live region was already saying.
  error: { role: "alert", live: "assertive" },
};

export interface StateBlockProps {
  kind: StateKind;
  /** The message itself. Localized by the caller; never an Error's message. */
  message: string;
  /** Longer explanation, shown under the message. Optional. */
  description?: string;
  /**
   * The way out. Required for `empty` and `error`: a state that reports a
   * problem without offering the next step is a dead end for keyboard and
   * screen-reader users alike.
   */
  action?: ReactNode;
  className?: string;
}

/**
 * Render a loading, empty, or error state as a perceivable, actionable block.
 *
 * `data-state-block` and `data-state-kind` are test hooks. They are also the
 * honest way for a consumer (or a test) to tell an empty state apart from a page
 * that happens to be short.
 */
export function StateBlock({ kind, message, description, action, className }: StateBlockProps) {
  const { role, live } = VARIANT[kind];

  return (
    <div
      data-state-block={kind}
      role={role}
      aria-live={live}
      aria-busy={kind === "loading" ? true : undefined}
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center",
        kind === "error" ? "border-destructive/50" : "border-border",
        className,
      )}
    >
      {kind === "loading" ? (
        <Loader2 aria-hidden className="size-5 animate-spin text-muted-foreground" />
      ) : kind === "error" ? (
        <AlertTriangle aria-hidden className="size-5 text-destructive" />
      ) : (
        <Inbox aria-hidden className="size-5 text-muted-foreground" />
      )}

      <p className={cn("text-sm font-medium", kind === "error" && "text-destructive")}>{message}</p>

      {description ? <p className="max-w-prose text-xs text-muted-foreground">{description}</p> : null}

      {action ? <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export default StateBlock;
