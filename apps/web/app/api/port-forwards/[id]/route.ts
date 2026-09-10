import { z } from "zod";
import { prisma } from "@xistance/db";
import { apiError, auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";
import { reconcilePortForwards } from "@/lib/forward-supervisor";

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  direction: z.enum(["IRAN_TO_FOREIGN", "FOREIGN_TO_IRAN"]).optional(),
  protocol: z.enum(["tcp", "udp"]).optional(),
  sourcePort: z.number().int().min(1).max(65535).optional(),
  destHost: z.string().min(1).optional(),
  destPort: z.number().int().min(1).max(65535).optional(),
  enabled: z.boolean().optional(),
  nodeId: z.string().uuid().optional().nullable(),
});

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const existing = await prisma.portForward.findUnique({ where: { id }, select: { userId: true, name: true } });
  if (!existing) return apiError("Rule not found", 404);
  if (auth.user.role === "USER" && existing.userId !== auth.user.id) {
    return apiError("Forbidden", 403);
  }
  const body = await parseBody(request, updateSchema);
  if (!body.ok) return body.response;

  if (body.data.nodeId) {
    const node = await prisma.node.findUnique({
      where: { id: body.data.nodeId },
      select: { id: true },
    });
    if (!node) return apiError("Node not found", 404);
  }

  const rule = await prisma.portForward.update({
    where: { id },
    data: { ...body.data, status: "pending" },
  });
  await reconcilePortForwards();
  await auditLog(auth.user.id, "portforward.update", id, rule.name, getClientIp(request));
  return json({ rule });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const existing = await prisma.portForward.findUnique({ where: { id }, select: { userId: true, name: true } });
  if (!existing) return apiError("Rule not found", 404);
  if (auth.user.role === "USER" && existing.userId !== auth.user.id) {
    return apiError("Forbidden", 403);
  }
  await prisma.portForward.delete({ where: { id } });
  await reconcilePortForwards();
  await auditLog(auth.user.id, "portforward.delete", id, existing.name, getClientIp(request));
  return json({ ok: true });
}
