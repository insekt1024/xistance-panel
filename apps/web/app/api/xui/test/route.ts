import { z } from "zod";
import { XUI_LOGIN_PATHS, normalizePanelUrl } from "@xistance/tunnel-core";
import { apiError, json, parseBody, requireSession } from "@/lib/api";
import { rejectPanelProbeHost } from "@/lib/panel-probe-host";
import { rateLimit } from "@/lib/rate-limit";

const xuiTestSchema = z.object({
  panelUrl: z.string().url().max(256),
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(256),
});

// Verify reachability + credentials against X-UI / 3X-UI HTTP API.
// Tries known login paths (x-ui vs 3x-ui differ); success = session cookie.
//
// The private/tailnet address space is deliberately reachable — a 3X-UI panel
// usually lives on the user's own VPS at a private address, and blocking RFC1918
// would break the feature. But "private" is not the same as "anything on the
// panel host", so three targets are refused unconditionally: loopback (the
// panel itself and any co-tenant service), link-local (the cloud metadata
// service at 169.254.169.254), and unspecified/broadcast. A USER is not
// supposed to reach the panel's own admin port through this route.
//
// Rate-limited per user (10/min) and requires a signed-in session.
export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const rl = rateLimit(`xui-test:${auth.user.id}`, 10, 60_000);
  if (!rl.ok) return apiError("Too many check requests, slow down", 429);
  const body = await parseBody(request, xuiTestSchema);
  if (!body.ok) return body.response;
  const base = normalizePanelUrl(body.data.panelUrl);
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return apiError("Invalid panel URL", 400);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return apiError("Only http and https panel URLs are allowed", 400);
  }
  if (parsed.username || parsed.password) {
    return apiError("Put credentials in the fields, not in the URL", 400);
  }
  const hostProblem = rejectPanelProbeHost(parsed.hostname);
  if (hostProblem) return apiError(hostProblem, 400);
  const form = new URLSearchParams();
  form.set("username", body.data.username);
  form.set("password", body.data.password);
  for (const loginPath of XUI_LOGIN_PATHS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(`${base}${loginPath}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: ctrl.signal,
        redirect: "manual",
      }).finally(() => clearTimeout(t));
      const ok = res.status === 200 || res.status === 302;
      if (ok) return json({ ok: true, result: { reachable: true, loginPath } });
    } catch {
      // try next login path
    }
  }
  return json({ ok: true, result: { reachable: false, loginPath: null } });
}
