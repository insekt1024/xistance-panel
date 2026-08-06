import { z } from "zod";
import { prisma } from "@xistance/db";
import { hashPassword, verifyPassword } from "@xistance/tunnel-core";
import { apiError, json, parseBody, requireSession } from "@/lib/api";

const passwordSchema = z.object({
  current: z.string().min(1),
  new: z.string().min(8),
});

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, passwordSchema);
  if (!body.ok) return body.response;

  const user = await prisma.user.findUnique({ where: { id: auth.user.id } });
  if (!user || !verifyPassword(body.data.current, user.passwordHash)) {
    return apiError("Current password is incorrect", 401);
  }
  await prisma.user.update({
    where: { id: auth.user.id },
    data: { passwordHash: hashPassword(body.data.new) },
  });
  return json({ ok: true });
}
