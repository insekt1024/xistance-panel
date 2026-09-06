import { prisma } from "@xistance/db";
import { json, requireSession } from "@/lib/api";

const LIST_LIMIT = 50;

export async function GET(request: Request) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const cursor = searchParams.get("cursor") ? { id: searchParams.get("cursor")! } : undefined;
  const limit = Math.min(Number(searchParams.get("limit")) || LIST_LIMIT, 100);

  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    cursor,
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

  const hasNext = logs.length === limit;
  const nextCursor = hasNext ? logs[logs.length - 1].id : null;
  return json({ logs, hasNext, nextCursor });
}
