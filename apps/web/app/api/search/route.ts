import { prisma } from "@xistance/db";
import { apiError, json, requireSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

const MAX_PER_TYPE = 5;

function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const rl = rateLimit(`search:${auth.user.id}`, 30, 60_000);
  if (!rl.ok) return apiError("Too many search requests, slow down", 429);

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();

  if (!q || q.length < 2) {
    return json({ tunnels: [], nodes: [], users: [] });
  }

  const like = escapeLike(q);
  // canSeeUsers, not "is a USER": admins may search the user directory.
  const canSeeUsers = auth.user.role === "ADMIN" || auth.user.role === "SUPER_ADMIN";

  const [tunnels, nodes, users] = await Promise.all([
    prisma.tunnel.findMany({
      where: {
        name: { contains: like },
        // Ownerless (ownerId null) tunnels 403 on detail for USER, so don't surface them either.
        ...(auth.user.role === "USER" ? { ownerId: auth.user.id } : {}),
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
      where: { name: { contains: like } },
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
    canSeeUsers
      ? prisma.user.findMany({
          where: {
            OR: [
              { email: { contains: like } },
              { name: { contains: like } },
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
