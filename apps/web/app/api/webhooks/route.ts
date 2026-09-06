import { z } from "zod";
import { prisma } from "@xistance/db";
import { auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";

const webhookCreateSchema = z.object({
  name: z.string().min(1).max(80),
  type: z.enum(["telegram", "discord"]),
  url: z.string().url(),
  events: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
});

export async function GET(request: Request) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;

  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 100);

  const webhooks = await prisma.notificationWebhook.findMany({
    take: limit + 1,
    ...(cursor ? { skip: 1, where: { id: { gt: cursor } } } : {}),
    orderBy: { createdAt: "asc" },
  });

  const hasNext = webhooks.length > limit;
  const items = hasNext ? webhooks.slice(0, limit) : webhooks;
  const nextCursor = hasNext ? items[items.length - 1].id : null;

  return json({ webhooks: items, hasNext, nextCursor });
}

export async function POST(request: Request) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;

  const body = await parseBody(request, webhookCreateSchema);
  if (!body.ok) return body.response;
  const data = body.data;

  const webhook = await prisma.notificationWebhook.create({
    data: {
      name: data.name,
      type: data.type,
      url: data.url,
      events: JSON.stringify(data.events),
      enabled: data.enabled,
    },
  });

  await auditLog(auth.user.id, "webhook.create", webhook.id, webhook.name, getClientIp(request));
  return json({ webhook }, 201);
}
