import { z } from "zod";
import { prisma } from "@xistance/db";
import { encryptSecret } from "@xistance/tunnel-core";
import { NodeConfigSchema } from "@xistance/types";
import { apiError, auditLog, getClientIp, invalidCursorResponse, json, paginationParams, parseBody, requireSession } from "@/lib/api";
import { clearNodeCache } from "@/lib/forward-supervisor";
import { redactNode } from "@/lib/tunnels";
import { invalidateCache } from "@/lib/query-cache";

const nodeCreateSchema = NodeConfigSchema.extend({
  apiToken: z.string().optional(),
});

const LIST_LIMIT = 50;

export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const { searchParams } = new URL(request.url);
  const { cursor, limit } = paginationParams(searchParams, LIST_LIMIT);
  let nodes;
  try {
    nodes = await prisma.node.findMany({
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor } : {}),
      select: {
        id: true, name: true, type: true, host: true, sshPort: true,
        sshUser: true, authMethod: true, sshKeyEncrypted: true,
        sshPasswordEnc: true, apiTokenEncrypted: true,
        status: true, lastSeen: true, health: true, createdAt: true, updatedAt: true,
      },
    });
  } catch (err) {
    const res = invalidCursorResponse(err);
    if (res) return res;
    throw err;
  }
  const hasNext = nodes.length > limit;
  const items = hasNext ? nodes.slice(0, limit) : nodes;
  const nextCursor = hasNext ? items[items.length - 1].id : null;
  const data = items.map(redactNode);
  return json({ nodes: data, hasNext, nextCursor });
}

export async function POST(request: Request) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, nodeCreateSchema);
  if (!body.ok) return body.response;
  const data = body.data;

  const existing = await prisma.node.findUnique({
    where: { name_type: { name: data.name, type: data.type } },
    select: { id: true },
  });
  if (existing) return apiError("A node with this name and type already exists", 409);

  const node = await prisma.node.create({
    data: {
      name: data.name,
      type: data.type,
      host: data.host,
      sshPort: data.port,
      sshUser: data.username,
      authMethod: data.authMethod,
      sshKeyEncrypted: data.key ? encryptSecret(data.key) : null,
      sshPasswordEnc: data.password ? encryptSecret(data.password) : null,
      apiTokenEncrypted: data.apiToken ? encryptSecret(data.apiToken) : null,
    },
  });
  await auditLog(auth.user.id, "node.create", node.id, node.name, getClientIp(request));
  clearNodeCache();
  invalidateCache();
  return json({ node: redactNode(node) }, 201);
}
