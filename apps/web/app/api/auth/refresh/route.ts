import { refreshSession } from "@/lib/auth";
import { apiError, json } from "@/lib/api";

export async function POST() {
  const user = await refreshSession();
  if (!user) return apiError("Refresh failed", 401);
  return json({ ok: true, user });
}
