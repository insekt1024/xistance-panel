import { prisma } from "@xistance/db";
import { apiError, auditLog, getClientIp, json, requireSession } from "@/lib/api";
import { getEngine } from "@/lib/engine";

async function findTunnel(id: string) {
  return prisma.tunnel.findUnique({
    where: { id },
    include: {
      clientNode: { select: { id: true, name: true, type: true, host: true } },
      serverNode: { select: { id: true, name: true, type: true, host: true } },
    },
  });
}

async function findTunnelMeta(id: string) {
  return prisma.tunnel.findUnique({
    where: { id },
    select: { id: true, name: true, ownerId: true, clientNodeId: true, serverNodeId: true },
  });
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const tunnel = await findTunnel(id);
  if (!tunnel) return apiError("Tunnel not found", 404);
  const live = getEngine().has(id) ? await getEngine().status(id) : tunnel.state;
  return json({ tunnel: { ...tunnel, liveState: live } });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const tunnel = await findTunnelMeta(id);
  if (!tunnel) return apiError("Tunnel not found", 404);
  if (auth.user.role === "USER" && tunnel.ownerId !== auth.user.id) {
    return apiError("Forbidden", 403);
  }
  if (getEngine().has(id)) {
    try {
      await getEngine().remove(id);
    } catch {
      /* best-effort stop */
    }
  }
  await prisma.tunnel.delete({ where: { id } });
  await auditLog(auth.user.id, "tunnel.delete", id, tunnel.name, getClientIp(request));
  return json({ ok: true });
}
