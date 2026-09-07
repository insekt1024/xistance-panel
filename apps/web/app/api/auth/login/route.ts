import { z } from "zod";
import { prisma } from "@xistance/db";
import { hashPassword, verifyPassword } from "@xistance/tunnel-core";
import { apiError, getClientIp, json, parseBody } from "@/lib/api";
import { createSession } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// Real-format dummy hash (computed once) so unknown-email attempts run the
// full scrypt verification — closes the user-enumeration timing oracle.
const DUMMY_HASH = hashPassword("xistance-never-matches-any-login");

export async function POST(request: Request) {
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
  // Always run a verification to equalize timing; dummy hash never matches.
  const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
  const passwordOk = user?.active ? verifyPassword(body.data.password, hashToCheck) : false;
  if (!user || !user.active || !passwordOk) return apiError("Invalid email or password", 401);

  await createSession({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    quota: user.quota,
    locale: user.locale,
    active: user.active,
    createdAt: user.createdAt,
  });
  return json({ ok: true });
}
