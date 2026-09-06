import { z } from "zod";
import { prisma } from "@xistance/db";
import { apiError, auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";

const webhookUpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  type: z.enum(["telegram", "discord"]).optional(),
  url: z.string().url().optional(),
  events: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
});

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;

  const existing = await prisma.notificationWebhook.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return apiError("Webhook not found", 404);

  const body = await parseBody(request, webhookUpdateSchema);
  if (!body.ok) return body.response;
  const data = body.data;

  const webhook = await prisma.notificationWebhook.update({
    where: { id },
    data: {
      name: data.name,
      type: data.type,
      url: data.url,
      events: data.events ? JSON.stringify(data.events) : undefined,
      enabled: data.enabled,
    },
  });

  await auditLog(auth.user.id, "webhook.update", id, webhook.name, getClientIp(request));
  return json({ webhook });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;

  const existing = await prisma.notificationWebhook.findUnique({ where: { id }, select: { name: true } });
  if (!existing) return apiError("Webhook not found", 404);

  await prisma.notificationWebhook.delete({ where: { id } });
  await auditLog(auth.user.id, "webhook.delete", id, existing.name, getClientIp(request));
  return json({ ok: true });
}
