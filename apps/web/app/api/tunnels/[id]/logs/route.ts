import { prisma } from "@xistance/db";
import { getEngine } from "@/lib/engine";
import { apiError, json, requireSession } from "@/lib/api";

async function authorizeTunnel(request: Request, id: string) {
  const auth = await requireSession(request);
  if (!auth.ok) return { response: auth.response } as const;
  const tunnel = await prisma.tunnel.findUnique({
    where: { id },
    select: { ownerId: true },
  });
  if (!tunnel) return { response: apiError("Tunnel not found", 404) } as const;
  if (auth.user.role === "USER" && tunnel.ownerId !== auth.user.id) {
    return { response: apiError("Forbidden", 403) } as const;
  }
  return { auth } as const;
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await authorizeTunnel(request, id);
  if ("response" in authz) return authz.response;
  const lines = getEngine().has(id) ? await getEngine().recentLogs(id, 300) : [];
  return json({ lines });
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await authorizeTunnel(request, id);
  if ("response" in authz) return authz.response;
  const snap = getEngine().has(id) ? await getEngine().snapshot(id) : null;
  return json({ snapshot: snap });
}
