import { z } from "zod";
import { prisma } from "@xistance/db";
import { apiError, auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";
import { reconcilePortForwardsSoon } from "@/lib/forward-supervisor";
import { rateLimit } from "@/lib/rate-limit";
import { rejectForwardHost } from "@/lib/forward-host";

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
  // Abuse bound: one authenticated session had no ceiling on this write, and
  // the cost is real server work, not just a database row.
  const rl = rateLimit(`pf-update:${auth.user.id}`, 30, 60000);
  if (!rl.ok) return apiError("Too many requests, slow down", 429);
  const { id } = await ctx.params;
  const existing = await prisma.portForward.findUnique({ where: { id }, select: { userId: true, name: true } });
  if (!existing) return apiError("Rule not found", 404);
  if (auth.user.role === "USER" && existing.userId !== auth.user.id) {
    return apiError("Forbidden", 403);
  }
  const body = await parseBody(request, updateSchema);
  if (!body.ok) return body.response;

  // Editing destHost is a create-shaped change: it re-points an existing
  // forward at a new target, so it needs the same guard POST does. Without
  // this, a rule created legitimately could be edited into an SSRF relay.
  if (body.data.destHost !== undefined) {
    const hostProblem = await rejectForwardHost(body.data.destHost);
    if (hostProblem) return apiError(hostProblem, 400);
  }

  if (body.data.nodeId) {
    const node = await prisma.node.findUnique({
      where: { id: body.data.nodeId },
      select: { id: true },
    });
    if (!node) return apiError("Node not found", 404);
  }

  // Same collision guard as create: moving a rule onto an occupied
  // protocol+port in the same node scope must 409, not double-bind.
  if (body.data.sourcePort !== undefined || body.data.protocol !== undefined || body.data.nodeId !== undefined || body.data.direction !== undefined) {
    const current = await prisma.portForward.findUnique({
      where: { id },
      select: { protocol: true, sourcePort: true, nodeId: true, direction: true },
    });
    const protocol = body.data.protocol ?? current?.protocol;
    const sourcePort = body.data.sourcePort ?? current?.sourcePort;
    const nodeId = body.data.nodeId !== undefined ? body.data.nodeId : current?.nodeId;
    const direction = body.data.direction ?? current?.direction;
    if (protocol && sourcePort && direction) {
      const clash = await prisma.portForward.findFirst({
        where: {
          id: { not: id },
          protocol,
          sourcePort,
          ...(nodeId ? { nodeId } : { nodeId: null, direction }),
        },
        select: { id: true, name: true },
      });
      if (clash) {
        return apiError(
          `Port ${sourcePort}/${protocol} is already forwarded by "${clash.name}" — pick another port or edit that rule`,
          409,
        );
      }
    }
  }

  const rule = await prisma.portForward.update({
    where: { id },
    data: { ...body.data, status: "pending" },
  });
  await reconcilePortForwardsSoon();
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
  await reconcilePortForwardsSoon();
  await auditLog(auth.user.id, "portforward.delete", id, existing.name, getClientIp(request));
  return json({ ok: true });
}
