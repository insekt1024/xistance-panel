import type { XuiConfig } from "@xistance/types";

// ---------------------------------------------------------------------------
// X-UI / 3X-UI integration — metadata only, zero extra processes.
// The panel talks to the 3X-UI HTTP API (login, list/get inbounds) to verify
// reachability and surface inbound status. Paths cover both alireza0/x-ui
// and MHSanaei/3x-ui login endpoints.
// ---------------------------------------------------------------------------

export const XUI_LOGIN_PATHS = ["/login", "/panel/login", "/xui/login"] as const;
export const XUI_INBOUNDS_PATH = "/panel/api/inbounds/list";
export function xuiInboundPath(id: number): string {
  return `/panel/api/inbounds/get/${id}`;
}

export function normalizePanelUrl(url: string): string {
  return url.replace(/\/+$/, "");
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
