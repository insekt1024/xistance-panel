import { NextResponse } from "next/server";
import type { z } from "zod";
import { prisma } from "@xistance/db";
import { assertCsrf, getSession, originAllowed, type SafeUser } from "./auth";

// ---------------------------------------------------------------------------
// Small helpers shared by route handlers: JSON responses, Zod body parsing,
// CSRF guards, RBAC and audit logging.
// ---------------------------------------------------------------------------

export function json<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function apiError(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function parseBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: apiError("Invalid JSON body", 400) };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const message = first ? `${first.path.join(".")}: ${first.message}` : "Validation failed";
    return { ok: false, response: apiError(message, 422) };
  }
  return { ok: true, data: parsed.data };
}

/** Enforce origin + CSRF double-submit on state-changing methods. */
export function csrfGuard(request: Request): NextResponse | null {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    if (!originAllowed(request)) return apiError("Cross-origin request rejected", 403);
    if (!assertCsrf(request)) return apiError("CSRF token mismatch", 403);
  }
  return null;
}

/** Require an authenticated user with at least the given role. */
export async function requireSession(
  request: Request,
  minRole: "USER" | "ADMIN" | "SUPER_ADMIN" = "USER",
): Promise<{ ok: true; user: SafeUser } | { ok: false; response: NextResponse }> {
  const csrf = csrfGuard(request);
  if (csrf) return { ok: false, response: csrf };
  const user = await getSession();
  if (!user) return { ok: false, response: apiError("Unauthorized", 401) };
  const rank: Record<string, number> = { USER: 0, ADMIN: 1, SUPER_ADMIN: 2 };
  if ((rank[user.role] ?? 0) < rank[minRole]) {
    return { ok: false, response: apiError("Forbidden", 403) };
  }
  return { ok: true, user };
}

export function getClientIp(request: Request): string | null {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip");
}

export async function auditLog(
  actorId: string | null,
  action: string,
  target?: string,
  details?: string,
  ip?: string | null,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { actorId, action, target, details, ip },
    });
  } catch {
    // Audit failures must never break the main request.
  }
}
