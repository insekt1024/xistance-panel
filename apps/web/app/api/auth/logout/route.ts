import { destroySession } from "@/lib/auth";
import { csrfGuard, json } from "@/lib/api";

export async function POST(request: Request) {
  const csrf = csrfGuard(request);
  if (csrf) return csrf;
  await destroySession();
  return json({ ok: true });
}
