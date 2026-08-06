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

export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const rules = await prisma.portForward.findMany({ orderBy: { createdAt: "desc" } });
  return json({ rules });
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
