import { z } from "zod";
import { prisma } from "@xistance/db";
import { auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";
import { reconcilePortForwards } from "@/lib/forward-supervisor";

const ruleSchema = z.object({
  name: z.string().min(1).max(80),
  direction: z.enum(["IRAN_TO_FOREIGN", "FOREIGN_TO_IRAN"]),
  protocol: z.enum(["tcp", "udp"]),
  sourcePort: z.number().int().min(1).max(65535),
  destHost: z.string().min(1),
  destPort: z.number().int().min(1).max(65535),
  enabled: z.boolean().default(true),
  nodeId: z.string().uuid().optional().nullable(),
});

const LIST_LIMIT = 50;

export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const { searchParams } = new URL(request.url);
  const cursor = searchParams.get("cursor") ? { id: searchParams.get("cursor")! } : undefined;
  const limit = Math.min(Number(searchParams.get("limit")) || LIST_LIMIT, 100);
  const where = auth.user.role === "USER" ? { userId: auth.user.id } : undefined;
  const portForwards = await prisma.portForward.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    cursor,
    select: {
      id: true,
      name: true,
      direction: true,
      protocol: true,
      sourcePort: true,
      destHost: true,
      destPort: true,
      enabled: true,
      status: true,
    },
  });
  const hasNext = portForwards.length === limit;
  const nextCursor = hasNext ? portForwards[portForwards.length - 1].id : null;
  return json({ rules: portForwards, hasNext, nextCursor });
}

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, ruleSchema);
  if (!body.ok) return body.response;

  const rule = await prisma.portForward.create({
    data: {
      name: body.data.name,
      userId: auth.user.id,
      direction: body.data.direction,
      protocol: body.data.protocol,
      sourcePort: body.data.sourcePort,
      destHost: body.data.destHost,
      destPort: body.data.destPort,
      enabled: body.data.enabled,
      nodeId: body.data.nodeId,
      status: "pending",
    },
  });
  await reconcilePortForwards();
  await auditLog(auth.user.id, "portforward.create", rule.id, rule.name, getClientIp(request));
  return json({ rule }, 201);
}
