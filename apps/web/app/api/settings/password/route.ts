import { z } from "zod";
import { prisma } from "@xistance/db";
import { hashPassword, verifyPassword } from "@xistance/tunnel-core";
import { apiError, json, parseBody, requireSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

const passwordSchema = z.object({
  current: z.string().min(1),
  new: z.string().min(8),
});

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  // Throttle attempts so the current-password check can't be brute-forced.
  const rl = rateLimit(`password:${auth.user.id}`, 5, 60_000);
  if (!rl.ok) return apiError("Too many attempts, try again shortly", 429);
  const body = await parseBody(request, passwordSchema);
  if (!body.ok) return body.response;

  const user = await prisma.user.findUnique({ where: { id: auth.user.id }, select: { passwordHash: true } });
  if (!user || !verifyPassword(body.data.current, user.passwordHash)) {
    return apiError("Current password is incorrect", 401);
  }
  await prisma.user.update({
    where: { id: auth.user.id },
    data: { passwordHash: hashPassword(body.data.new) },
  });
  // Revoke all existing sessions to force re-authentication
  await prisma.session.updateMany({
    where: { userId: auth.user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return json({ ok: true });
}
