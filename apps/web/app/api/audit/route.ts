import { prisma } from "@xistance/db";
import { apiError, invalidCursorResponse, json, paginationParams, requireSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

const LIST_LIMIT = 50;

export async function GET(request: Request) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;
  const rl = rateLimit(`audit:${auth.user.id}`, 30, 60_000);
  if (!rl.ok) return apiError("Too many requests, slow down", 429);

  const { searchParams } = new URL(request.url);
  const { cursor, limit } = paginationParams(searchParams, LIST_LIMIT);

  let logs;
  try {
    logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor } : {}),
      select: {
        id: true,
        actorId: true,
        action: true,
        target: true,
        details: true,
        ip: true,
        createdAt: true,
        actor: { select: { id: true, name: true, email: true } },
      },
    });
  } catch (err) {
    const res = invalidCursorResponse(err);
    if (res) return res;
    throw err;
  }

  const hasNext = logs.length > limit;
  const items = hasNext ? logs.slice(0, limit) : logs;
  const nextCursor = hasNext ? items[items.length - 1].id : null;
  return json({ logs: items, hasNext, nextCursor });
}
