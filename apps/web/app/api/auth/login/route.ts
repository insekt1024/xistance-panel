import { z } from "zod";
import { prisma } from "@xistance/db";
import { verifyPassword } from "@xistance/tunnel-core";
import { apiError, getClientIp, json, parseBody } from "@/lib/api";
import { createSession } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  const ip = getClientIp(request) ?? "unknown";
  const rl = rateLimit(`login:${ip}`, 5, 60_000);
  if (!rl.ok) return apiError("Too many login attempts", 429);

  const body = await parseBody(request, loginSchema);
  if (!body.ok) return body.response;

  const user = await prisma.user.findUnique({
    where: { email: body.data.email.toLowerCase().trim() },
    select: {
      id: true, email: true, name: true, role: true, quota: true,
      locale: true, active: true, createdAt: true, passwordHash: true,
    },
  });
  if (!user || !user.active) return apiError("Invalid email or password", 401);
  if (!verifyPassword(body.data.password, user.passwordHash)) {
    return apiError("Invalid email or password", 401);
  }

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
