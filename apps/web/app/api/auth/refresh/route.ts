import { refreshSession, requestIsHttps } from "@/lib/auth";
import { apiError, csrfGuard, json } from "@/lib/api";

export async function POST(request: Request) {
  const csrf = csrfGuard(request);
  if (csrf) return csrf;
  const user = await refreshSession({ secure: requestIsHttps(request) });
  if (!user) return apiError("Refresh failed", 401);
  return json({ ok: true, user });
}
