import { prisma } from "@xistance/db";
import { apiError, json, requireSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { cached } from "@/lib/query-cache";

const LIST_LIMIT = 50;

export async function GET(request: Request) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;
  const rl = rateLimit(`users-activity:${auth.user.id}`, 30, 60_000);
  if (!rl.ok) return apiError("Too many requests, slow down", 429);

  const { searchParams } = new URL(request.url);
  const cursor = searchParams.get("cursor") ? { id: searchParams.get("cursor")! } : undefined;
  const limit = Math.min(Number(searchParams.get("limit")) || LIST_LIMIT, 100);
  const userId = searchParams.get("userId");
  const action = searchParams.get("action");

  const where: Record<string, unknown> = {};
  if (userId) where.actorId = userId;
  if (action) where.action = { contains: action };

  const actionTypes = await cached("activity:actions", 60_000, () =>
    prisma.auditLog.findMany({
      select: { action: true },
      distinct: ["action"],
      orderBy: { action: "asc" },
    }),
  );

  const logs = await prisma.auditLog.findMany({
    where,
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

  const hasNext = logs.length > limit;
  const items = hasNext ? logs.slice(0, limit) : logs;
  const nextCursor = hasNext ? items[items.length - 1].id : null;
  return json({
    logs: items,
    hasNext,
    nextCursor,
    actionTypes: actionTypes.map((a) => a.action),
  });
}
