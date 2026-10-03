/**
 * Lifecycle diagnostics (TASK-22).
 *
 * The engine already knows why a tunnel failed, but that knowledge was trapped
 * in an exception message and, in the worst case, in the argv of a process
 * whose arguments may contain a decrypted secret. This module turns the failure
 * into a small, sanitised, queryable value.
 *
 * Rules this file exists to enforce:
 *  - a diagnostic NEVER carries a command line, a password, a token, or key
 *    material. `sanitizeForDiagnostics` is the only sanctioned path from an
 *    arbitrary string into a diagnostic;
 *  - the vocabulary of error categories and recovery actions is a closed set,
 *    so the UI can localize it exhaustively and never render an unknown key;
 *  - retention is bounded, because this is an in-memory store in a process
 *    that is expected to run for months on a 1 vCPU VPS.
 */

/** Closed set of error categories. Localizable, and deliberately small. */
export const DIAGNOSTIC_ERROR_CATEGORIES = [
  "unreachable",
  "permission",
  "resource",
  "missing_binary",
  "configuration",
  "authentication",
  "timeout",
  "unknown",
] as const;
export type DiagnosticErrorCategory = (typeof DIAGNOSTIC_ERROR_CATEGORIES)[number];

/** Closed set of recovery actions the UI can offer. */
export const RecoveryAction = {
  NONE: "none",
  WAIT: "wait",
  RETRY: "retry",
  RESTART: "restart",
  RECHECK: "recheck",
  FIX_CONFIG: "fix_config",
} as const;
export type RecoveryAction = (typeof RecoveryAction)[keyof typeof RecoveryAction];

/** The sanitised diagnostic surface. Every field is safe to log or return. */
export interface TunnelDiagnostic {
  /** Tunnel lifecycle state, mirrors TunnelStatus. */
  state: string;
  /** Epoch ms of the last state transition. */
  lastTransitionAt: number;
  /** Why it failed, or null when healthy. */
  errorCategory: DiagnosticErrorCategory | null;
  /** Short, redacted, human-readable detail. Never the raw argv. */
  summary: string;
  /** Consecutive failed attempts. */
  retryCount: number;
  /** The single next action an operator should take. */
  nextAction: RecoveryAction;
  /** True once the retry ceiling is reached and automatic recovery stopped. */
  exhausted: boolean;
}

/**
 * Patterns matched case-insensitively against free text.
 *
 * Order matters: the more specific credential patterns run before the generic
 * `--flag value` sweep, so `password=hunter2` is not first rewritten into
 * `password=***` and then left with the value visible.
 */
const REDACTIONS: Array<{ re: RegExp; to: string }> = [
  // PEM / key material, before anything can split it.
  { re: /-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----/g, to: "[redacted-key]" },
  { re: /-----BEGIN[^-]*-----/g, to: "[redacted-key]" },
  // key=value / key: value credential pairs.
  {
    re: /\b(password|passwd|pwd|token|secret|apikey|api_key|auth|authorization|credential)\b\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi,
    to: "$1=***",
  },
  // Credential-bearing flags with a following value.
  {
    re: /(-p|--password|--passwd|--token|--secret|--api[-_]?key|--auth|-i\s|--identity)\s+("[^"]*"|'[^']*'|\S+)/g,
    to: "$1 ***",
  },
  // -pVALUE with no separator.
  { re: /(^|\s)-p\S+/g, to: "$1-p***" },
  // Key file paths: the path itself is a secret location.
  { re: /(\/etc\/[^\s"']*id_[a-z0-9]+|\.ssh\/id_[a-z0-9]+|-i\s+\S+)/g, to: "[redacted-keypath]" },
  // Long opaque blobs that are almost certainly credentials.
  { re: /\b[A-Za-z0-9_-]{32,}\b/g, to: "***" },
];

const MAX_SUMMARY = 200;

/**
 * Reduce arbitrary text to something safe to expose.
 *
 * This is deliberately conservative: it keeps the program name, host, and port
 * so the message stays actionable, and removes anything that looks like a
 * credential. It is not a general-purpose sanitizer and must not be treated as
 * one -- which is why nothing else in the codebase formats diagnostics.
 */
export function sanitizeForDiagnostics(input: string | undefined | null): string {
  if (!input) return "";
  let out = String(input);
  // Strip control characters that could break log lines or terminal output.
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u001f\u007f]/g, " ");
  for (const { re, to } of REDACTIONS) {
    out = out.replace(re, to);
  }
  out = out.replace(/\s+/g, " ").trim();
  if (out.length > MAX_SUMMARY) out = `${out.slice(0, MAX_SUMMARY - 1)}…`;
  return out;
}

/**
 * Map a message to a closed category.
 *
 * Matching is on stable substrings rather than a parser, because the messages
 * come from ssh/systemd/binary stderr and are not uniform. `unknown` is the
 * deliberate catch-all: a new message must never produce a category the UI
 * cannot render.
 */
export function classifyError(message: string | undefined | null): DiagnosticErrorCategory {
  const m = (message ?? "").toLowerCase();
  if (!m) return "unknown";
  if (m.includes("no space left") || m.includes("cannot allocate memory") || m.includes("out of memory") || m.includes("oom")) {
    return "resource";
  }
  if (m.includes("not found") && (m.includes("binary") || m.includes("executable") || m.includes("enoent"))) {
    return "missing_binary";
  }
  if (m.includes("command not found")) return "missing_binary";
  // Authentication BEFORE the generic permission check: "Permission denied
  // (publickey)" is an auth failure, not a filesystem permission problem, and
  // telling an operator to chmod their way out of it is actively misleading.
  if (
    m.includes("permission denied (publickey") ||
    m.includes("authentication failed") ||
    m.includes("too many authentication failures") ||
    m.includes("host key verification failed") ||
    m.includes("auth failed")
  ) {
    return "authentication";
  }
  if (m.includes("timed out") || m.includes("timeout") || m.includes("etimedout")) return "timeout";
  if (
    m.includes("connection refused") ||
    m.includes("could not resolve") ||
    m.includes("no route to host") ||
    m.includes("network is unreachable") ||
    m.includes("host is down")
  ) {
    return "unreachable";
  }
  if (m.includes("permission denied") || m.includes("eacces") || m.includes("eperm") || m.includes("operation not permitted")) {
    return "permission";
  }
  if (m.includes("config") || m.includes("parse") || m.includes("invalid json") || m.includes("schema")) {
    return "configuration";
  }
  return "unknown";
}

export interface BuildDiagnosticInput {
  status: string;
  error?: string | null;
  retryCount?: number;
  exhausted?: boolean;
  now?: number;
}

/** Choose the single next action. Bounded: never "retry forever". */
export function nextRecoveryAction(input: {
  errorCategory: DiagnosticErrorCategory | null;
  retryCount: number;
  exhausted: boolean;
}): RecoveryAction {
  if (input.errorCategory === null) return RecoveryAction.NONE;
  // Automatic recovery has stopped: the operator must intervene.
  if (input.exhausted) return RecoveryAction.RESTART;
  if (input.errorCategory === "configuration") return RecoveryAction.FIX_CONFIG;
  if (input.retryCount <= 1) return RecoveryAction.RETRY;
  if (input.retryCount <= 3) return RecoveryAction.WAIT;
  return RecoveryAction.RECHECK;
}

/** Build a sanitised diagnostic from a failure. Pure and synchronous. */
export function buildDiagnostic(input: BuildDiagnosticInput): TunnelDiagnostic {
  const errorCategory = input.error ? classifyError(input.error) : null;
  const retryCount = Math.max(0, input.retryCount ?? 0);
  return {
    state: input.status,
    lastTransitionAt: input.now ?? Date.now(),
    errorCategory,
    summary: sanitizeForDiagnostics(input.error ?? ""),
    retryCount,
    nextAction: nextRecoveryAction({
      errorCategory,
      retryCount,
      exhausted: input.exhausted ?? false,
    }),
    exhausted: input.exhausted ?? false,
  };
}

/**
 * Bounded, per-tunnel diagnostic history.
 *
 * Retention is a count per tunnel, not a global count, so one noisy tunnel
 * cannot evict the history of every other tunnel.
 */
export function diagnosticStore(retention = 20) {
  const cap = Math.max(1, retention);
  const byTunnel = new Map<string, TunnelDiagnostic[]>();

  return {
    record(tunnelId: string, d: TunnelDiagnostic): void {
      const list = byTunnel.get(tunnelId) ?? [];
      list.push(d);
      // Drop the oldest beyond the cap.
      if (list.length > cap) list.splice(0, list.length - cap);
      byTunnel.set(tunnelId, list);
    },
    list(tunnelId: string): TunnelDiagnostic[] {
      // A copy, so a caller cannot mutate the store.
      return [...(byTunnel.get(tunnelId) ?? [])];
    },
    latest(tunnelId: string): TunnelDiagnostic | null {
      const list = byTunnel.get(tunnelId);
      return list && list.length > 0 ? list[list.length - 1] : null;
    },
    clear(tunnelId: string): void {
      byTunnel.delete(tunnelId);
    },
    size(): number {
      return byTunnel.size;
    },
    /**
     * Aggregate of the newest diagnostic per tunnel, in ONE pass.
     *
     * Metrics must not call `latest()` per tunnel: that is a per-request scan
     * whose cost grows with the tunnel count, which is exactly the unbounded
     * collection this feature must avoid. This walks the map once and buckets
     * the last record of each tunnel, so the cost is O(tunnels) per cache
     * refresh and O(1) per served request.
     *
     * The summary text is NOT included: it is free-form and can be long, and a
     * metrics payload has no use for it.
     */
    aggregate(): {
      byState: Record<string, number>;
      byErrorCategory: Record<string, number>;
      retrying: number;
      exhausted: number;
      tracked: number;
    } {
      const byState: Record<string, number> = {};
      const byErrorCategory: Record<string, number> = {};
      let retrying = 0;
      let exhausted = 0;
      for (const list of byTunnel.values()) {
        if (list.length === 0) continue;
        const latest = list[list.length - 1];
        byState[latest.state] = (byState[latest.state] ?? 0) + 1;
        if (latest.errorCategory) {
          byErrorCategory[latest.errorCategory] = (byErrorCategory[latest.errorCategory] ?? 0) + 1;
        }
        if (latest.retryCount > 0) retrying += 1;
        if (latest.exhausted) exhausted += 1;
      }
      return { byState, byErrorCategory, retrying, exhausted, tracked: byTunnel.size };
    },
  };
}

export type DiagnosticStore = ReturnType<typeof diagnosticStore>;
