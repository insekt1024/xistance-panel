import { prisma } from "@xistance/db";
import { json, requireSession } from "@/lib/api";

const MAX_PER_TYPE = 5;

export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();

  if (!q || q.length < 2) {
    return json({ tunnels: [], nodes: [], users: [] });
  }

  const isUser = auth.user.role === "ADMIN" || auth.user.role === "SUPER_ADMIN";

  const [tunnels, nodes, users] = await Promise.all([
    prisma.tunnel.findMany({
      where: {
        name: { contains: q },
        ...(auth.user.role === "USER"
          ? { OR: [{ ownerId: auth.user.id }, { ownerId: null }] }
          : {}),
      },
      take: MAX_PER_TYPE,
      select: {
        id: true,
        name: true,
        method: true,
        status: true,
      },
      orderBy: { name: "asc" },
    }),
    prisma.node.findMany({
      where: { name: { contains: q } },
      take: MAX_PER_TYPE,
      select: {
        id: true,
        name: true,
        type: true,
        host: true,
        status: true,
      },
      orderBy: { name: "asc" },
    }),
    isUser
      ? prisma.user.findMany({
          where: {
            OR: [
              { email: { contains: q } },
              { name: { contains: q } },
            ],
          },
          take: MAX_PER_TYPE,
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
          },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
  ]);

  return json({ tunnels, nodes, users });
}
