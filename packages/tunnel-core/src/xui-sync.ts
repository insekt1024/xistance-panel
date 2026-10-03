import { normalizePanelUrl, xuiInboundPath, xuiLoginBody, XUI_LOGIN_PATHS } from "./config/xui.js";
import type { XuiConfig } from "@xistance/types";

// ---------------------------------------------------------------------------
// X-UI / 3X-UI verification (TASK-34).
//
// XUI is metadata-only: no process runs on our nodes, so unlike every other
// method there is nothing whose liveness proves the tunnel exists. Before this
// module, `planXui` wrote a pointer file and reported `running` -- meaning a
// tunnel was "running" when the panel URL was a typo and the credentials were
// wrong, as long as a deploy had been issued.
//
// The rule here: `running` means a real inbound was fetched from the panel and
// that inbound is up. Everything else is `degraded` or `error`, and the reason
// is preserved so the UI can say which.
// ---------------------------------------------------------------------------

/** Why a sync attempt ended the way it did. */
export type XuiSyncKind =
  | "ok"
  | "auth"
  | "unreachable"
  | "rate_limited"
  | "malformed"
  | "missing_inbound"
  | "aborted";

export interface XuiInbound {
  id: number;
  up: boolean;
  remark?: string | null;
  port?: number | null;
}

export type XuiSyncResult =
  | { ok: true; kind: "ok"; inbound: XuiInbound; loginPath: string }
  | { ok: false; kind: Exclude<XuiSyncKind, "ok">; detail: string; retryable: boolean };

/**
 * Bounded retry policy.
 *
 * The cap matters more than the count: a 3X-UI panel on a 1 vCPU VPS that is
 * slow to answer must not be hammered, and a sync loop that retries forever
 * turns a temporary outage into a permanent one. Exposed (rather than
 * hard-coded) so the behaviour is assertable.
 */
export const XUI_RETRY_POLICY = {
  maxAttempts: 3,
  baseMs: 500,
  capMs: 5_000,
} as const;

/** Map a sync outcome onto a tunnel status. */
export function classifyXuiSync(result: XuiSyncResult): "running" | "degraded" | "error" {
  if (result.ok) {
    // A successful fetch is not the same as a healthy inbound. 3x-ui reports
    // liveness as `enable`; when it is false the panel is reachable and the
    // inbound is deliberately stopped, which is `degraded`, not `running`.
    // Reported here rather than left to each caller so the rule cannot drift.
    return result.inbound.up ? "running" : "degraded";
  }
  switch (result.kind) {
    // Rate limited: the panel is alive and answered, we are simply being
    // throttled. Recoverable, and the next tick will do it.
    case "rate_limited":
      return "degraded";
    // Everything else -- auth, unreachable, malformed, missing inbound,
    // aborted -- is a real fault. A stopped inbound never reaches here: it is
    // an `ok` result carrying `up: false`, and the caller decides what that
    // means for display.
    default:
      return "error";
  }
}

export interface SyncOptions {
  signal?: AbortSignal;
  /** Injected so cancellation can be tested without real waiting. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Exponential backoff, capped, and abortable. */
function backoffMs(attempt: number): number {
  return Math.min(XUI_RETRY_POLICY.baseMs * 2 ** attempt, XUI_RETRY_POLICY.capMs);
}

/** Redact anything credential-shaped out of a detail string. */
function safeDetail(s: string): string {
  return s
    .replace(/(password|passwd|pwd|token|secret|auth)\s*[=:]\s*\S+/gi, "$1=***")
    .slice(0, 200);
}

interface RawInbound {
  id?: unknown;
  up?: unknown;
  enable?: unknown;
  remark?: unknown;
  port?: unknown;
}

/**
 * Verify the panel, the credentials, and (when configured) the inbound.
 *
 * Never throws: a failure is a result, because every caller wants a status
 * rather than an exception. Retries are bounded and abortable so a stop or
 * update does not wait out the backoff.
 */
export async function syncXui(cfg: XuiConfig, opts: SyncOptions = {}): Promise<XuiSyncResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const base = normalizePanelUrl(cfg.panelUrl);
  const form = xuiLoginBody(cfg);

  let last: XuiSyncResult = {
    ok: false,
    kind: "unreachable",
    detail: "no attempt was made",
    retryable: true,
  };

  for (let attempt = 0; attempt < XUI_RETRY_POLICY.maxAttempts; attempt += 1) {
    if (opts.signal?.aborted) {
      return { ok: false, kind: "aborted", detail: "cancelled", retryable: false };
    }
    try {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(), 8_000);
      try {
        // 1. Log in. A 200/302 with a session cookie is success.
        let loggedIn = false;
        let loginPath: string = XUI_LOGIN_PATHS[0];
        for (const p of XUI_LOGIN_PATHS) {
          const res = await fetchImpl(`${base}${p}`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: form.toString(),
            signal: ctrl.signal,
            redirect: "manual",
          });
          if (res.status === 429) {
            return { ok: false, kind: "rate_limited", detail: "the panel rate limited the login", retryable: true };
          }
          if (res.status === 200 || res.status === 302) {
            loggedIn = true;
            loginPath = p;
            break;
          }
          if (res.status === 401 || res.status === 403) {
            return { ok: false, kind: "auth", detail: "the panel rejected the username or password", retryable: false };
          }
        }
        if (!loggedIn) {
          return { ok: false, kind: "auth", detail: "the panel did not accept the login on any known path", retryable: false };
        }

        // 2. Fetch the inbound. Without one, a successful login is all we can
        //    prove -- and that is genuinely less than "running".
        //
        //    It used to return `up: true` here, which classifyXuiSync mapped
        //    straight to "running" -- so a tunnel whose panel URL and
        //    credentials were correct, but which had no inbound verified at all,
        //    was reported to the operator as RUNNING. That is the exact failure
        //    this module exists to prevent (see the header: a tunnel was
        //    "running" whenever a deploy had been issued), arriving through a
        //    different door. A login proves the PANEL is reachable, not that a
        //    tunnel is up, so `up: false` maps to "degraded".
        if (cfg.inboundId == null) {
          return { ok: true, kind: "ok", loginPath, inbound: { id: 0, up: false } };
        }

        const res = await fetchImpl(`${base}${xuiInboundPath(cfg.inboundId)}`, {
          headers: { accept: "application/json" },
          signal: ctrl.signal,
          redirect: "manual",
        });
        if (res.status === 429) {
          return { ok: false, kind: "rate_limited", detail: "the panel rate limited the inbound fetch", retryable: true };
        }
        if (res.status === 404) {
          return { ok: false, kind: "missing_inbound", detail: `inbound ${cfg.inboundId} does not exist on the panel`, retryable: false };
        }
        if (!res.ok) {
          return { ok: false, kind: "unreachable", detail: `the panel answered ${res.status}`, retryable: true };
        }
        const text = await res.text();
        let doc: { obj?: RawInbound } | RawInbound;
        try {
          doc = JSON.parse(text) as { obj?: RawInbound };
        } catch {
          // An HTML login page here means the session did not hold.
          return { ok: false, kind: "malformed", detail: "the panel returned a non-JSON response", retryable: false };
        }
        const obj = (doc as { obj?: RawInbound }).obj ?? (doc as RawInbound);
        if (obj == null || typeof obj !== "object" || obj.id === undefined) {
          return { ok: false, kind: "malformed", detail: "the panel response did not contain an inbound", retryable: false };
        }
        const inbound: XuiInbound = {
          id: Number(obj.id),
          // 3x-ui reports liveness as `enable`; `up` appears on some forks.
          up: obj.up === true || obj.enable === true,
          remark: typeof obj.remark === "string" ? obj.remark : null,
          port: typeof obj.port === "number" ? obj.port : null,
        };
        return { ok: true, kind: "ok", loginPath, inbound };
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
      }
    } catch (e) {
      if (opts.signal?.aborted) {
        return { ok: false, kind: "aborted", detail: "cancelled", retryable: false };
      }
      last = { ok: false, kind: "unreachable", detail: safeDetail((e as Error).message), retryable: true };
    }

    if (opts.signal?.aborted) {
      return { ok: false, kind: "aborted", detail: "cancelled", retryable: false };
    }
    if (attempt < XUI_RETRY_POLICY.maxAttempts - 1) {
      await sleep(backoffMs(attempt), opts.signal);
    }
  }
  return last;
}
