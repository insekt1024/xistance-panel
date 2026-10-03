import { z } from "zod";
import { prisma } from "@xistance/db";
import { hashPassword, verifyPassword } from "@xistance/tunnel-core";
import { apiError, auditLog, getClientIp, json, parseBody } from "@/lib/api";
import { createSession, originAllowed, requestIsHttps } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Real-format dummy hash (computed once) so unknown-email attempts run the
// full scrypt verification — closes the user-enumeration timing oracle.
const DUMMY_HASH = hashPassword("xistance-never-matches-any-login");

export async function POST(request: Request) {
  // No CSRF token here: there is no session yet, so there is nothing to
  // double-submit. The Origin check is NOT skippable, though -- without it this
  // endpoint accepted a cross-site form post, which is the classic login-CSRF
  // that forces a victim's browser to authenticate as an attacker's account.
  if (!originAllowed(request)) {
    return apiError("Cross-origin request rejected", 403);
  }
  const body = await parseBody(request, loginSchema);
  if (!body.ok) return body.response;
  const email = body.data.email.toLowerCase().trim();

  // Per-email bucket is spoof-proof (header rotation can't bypass it);
  // per-IP bucket additionally throttles distributed spray when trusted.
  const rlEmail = rateLimit(`login:email:${email}`, 10, 60_000);
  if (!rlEmail.ok) return apiError("Too many login attempts", 429);
  const ip = getClientIp(request);
  if (ip) {
    const rlIp = rateLimit(`login:ip:${ip}`, 20, 60_000);
    if (!rlIp.ok) return apiError("Too many login attempts", 429);
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true, email: true, name: true, role: true, quota: true,
      locale: true, active: true, createdAt: true, passwordHash: true,
    },
  });
  // Always run a verification, on EVERY path, so unknown-email, deactivated and
  // wrong-password attempts all pay the same scrypt cost.
  //
  // This used to be:
  //     const passwordOk = user?.active ? verifyPassword(pw, hashToCheck) : false;
  // The ternary short-circuits on `user?.active`, so verifyPassword was NEVER
  // CALLED for an unknown email or a deactivated account -- the two branches
  // DUMMY_HASH exists to protect. Measured: a wrong password against a real
  // account took ~33ms, an unknown email ~0.001ms. A 30000x difference is far
  // above network jitter, so account existence (and deactivation) was remotely
  // enumerable even though the response body and status were identical.
  //
  // The boolean is then ANDed separately: the verification runs first and
  // unconditionally, and `active` is only ever an additional rejection.
  const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
  const passwordOk = verifyPassword(body.data.password, hashToCheck);
  if (!user || !user.active || !passwordOk) {
    // Throttled endpoint: safe to log failures for brute-force visibility.
    await auditLog(null, "auth.login-failed", undefined, email, getClientIp(request));
    // Names neither field individually, so the message cannot drift into
    // "email" and "password" branches later. Both failure cases return it
    // verbatim.
    return apiError("Invalid credentials", 401);
  }
  await auditLog(user.id, "auth.login", undefined, undefined, getClientIp(request));

  // Secure cookies are dropped by clients on plain HTTP — only set the flag
  // when the request actually arrived over HTTPS (direct or via proxy).
  const isHttps = requestIsHttps(request);
  await createSession(
    {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      quota: user.quota,
      locale: user.locale,
      active: user.active,
      createdAt: user.createdAt,
    },
    { secure: isHttps },
  );
  return json({ ok: true });
}
