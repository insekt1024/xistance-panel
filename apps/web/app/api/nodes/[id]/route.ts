import { z } from "zod";
import { prisma } from "@xistance/db";
import { encryptSecret } from "@xistance/tunnel-core";
import { NodeConfigSchema } from "@xistance/types";
import { apiError, auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";
import { redactNode } from "@/lib/tunnels";

const nodeUpdateSchema = NodeConfigSchema.extend({
  apiToken: z.string().optional(),
}).partial();

async function findNode(id: string) {
  return prisma.node.findUnique({ where: { id } });
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const node = await findNode(id);
  if (!node) return apiError("Node not found", 404);
  return json({ node: redactNode(node) });
}

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const existing = await findNode(id);
  if (!existing) return apiError("Node not found", 404);

  const body = await parseBody(request, nodeUpdateSchema);
  if (!body.ok) return body.response;
  const data = body.data;

  const node = await prisma.node.update({
    where: { id },
    data: {
      name: data.name,
      type: data.type,
      host: data.host,
      sshPort: data.port,
      sshUser: data.username,
      authMethod: data.authMethod,
      sshKeyEncrypted:
        data.key !== undefined
          ? data.key
            ? encryptSecret(data.key)
            : null
          : undefined,
      sshPasswordEnc:
        data.password !== undefined
          ? data.password
            ? encryptSecret(data.password)
            : null
          : undefined,
      apiTokenEncrypted:
        data.apiToken !== undefined
          ? data.apiToken
            ? encryptSecret(data.apiToken)
            : null
          : undefined,
    },
  });
  await auditLog(auth.user.id, "node.update", node.id, node.name, getClientIp(request));
  return json({ node: redactNode(node) });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const existing = await findNode(id);
  if (!existing) return apiError("Node not found", 404);

  const used = await prisma.tunnel.count({
    where: { OR: [{ clientNodeId: id }, { serverNodeId: id }] },
  });
  if (used > 0) {
    return apiError("This node is used by active tunnels. Remove them first.", 409);
  }
  await prisma.node.delete({ where: { id } });
  await auditLog(auth.user.id, "node.delete", id, existing.name, getClientIp(request));
  return json({ ok: true });
}
