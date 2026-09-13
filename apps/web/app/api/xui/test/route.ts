import { z } from "zod";
import { XUI_LOGIN_PATHS, normalizePanelUrl } from "@xistance/tunnel-core";
import { apiError, json, parseBody, requireSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

const xuiTestSchema = z.object({
  panelUrl: z.string().url().max(256),
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(256),
});

// Verify reachability + credentials against X-UI / 3X-UI HTTP API.
// Tries known login paths (x-ui vs 3x-ui differ); success = session cookie.
// NOTE: intentionally no SSRF private-IP block here — 3X-UI panels usually
// live on the user's own VPS (often a private/tailnet address). Rate-limited
// per user (10/min) and requires a signed-in session.
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
