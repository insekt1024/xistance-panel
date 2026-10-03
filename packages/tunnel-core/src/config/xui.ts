import type { XuiConfig } from "@xistance/types";

// ---------------------------------------------------------------------------
// X-UI / 3X-UI integration — metadata only, zero extra processes.
// The panel talks to the 3X-UI HTTP API (login, list/get inbounds) to verify
// reachability and surface inbound status. Paths cover both alireza0/x-ui
// and MHSanaei/3x-ui login endpoints.
// ---------------------------------------------------------------------------

export const XUI_LOGIN_PATHS = ["/login", "/panel/login", "/xui/login"] as const;
export const XUI_INBOUNDS_PATH = "/panel/api/inbounds/list";
/**
 * Build the inbound path from a numeric id.
 *
 * A non-numeric id is a caller bug, and interpolating it verbatim produced
 * `/panel/api/inbounds/get/NaN` -- a request the panel cannot answer, with an
 * error that does not explain why. Refuse instead.
 */
export function xuiInboundPath(id: number): string {
  if (!Number.isInteger(id) || id < 1) {
    throw new Error(`Invalid XUI inbound id: ${JSON.stringify(id)}. Expected a positive integer.`);
  }
  return `/panel/api/inbounds/get/${id}`;
}

/**
 * Strip trailing slashes and, defensively, any embedded credentials.
 *
 * The schema already refuses credentials in a panel URL, but this function is
 * also reachable from paths that do not go through the schema, and a URL with
 * credentials would put a secret into a request line, a log line and the UI.
 * Dropping them here means the worst case is an unauthenticated request rather
 * than a leaked password.
 */
export function normalizePanelUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  // Only rewrite when it really is a parseable URL with a userinfo part;
  // otherwise hand back the trimmed string untouched.
  const m = /^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@(.+)$/i.exec(trimmed);
  return m ? `${m[1]}${m[2]}` : trimmed;
}

export function buildXuiSyncPayload(cfg: XuiConfig): {
  baseUrl: string;
  inboundPath: string | null;
} {
  const baseUrl = normalizePanelUrl(cfg.panelUrl);
  return { baseUrl, inboundPath: cfg.inboundId ? xuiInboundPath(cfg.inboundId) : null };
}

/** Minimal login form body shared by x-ui and 3x-ui. */
export function xuiLoginBody(cfg: Pick<XuiConfig, "username" | "password">): URLSearchParams {
  const body = new URLSearchParams();
  body.set("username", cfg.username);
  body.set("password", cfg.password);
  return body;
}
