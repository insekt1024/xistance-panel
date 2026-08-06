import { z } from "zod";
import { prisma } from "@xistance/db";
import { encryptSecret } from "@xistance/tunnel-core";
import { NodeConfigSchema } from "@xistance/types";
import { apiError, auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";
import { redactNode } from "@/lib/tunnels";

const nodeCreateSchema = NodeConfigSchema.extend({
  apiToken: z.string().optional(),
});

export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const nodes = await prisma.node.findMany({ orderBy: { createdAt: "desc" } });
  return json({ nodes: nodes.map(redactNode) });
}

export async function POST(request: Request) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, nodeCreateSchema);
  if (!body.ok) return body.response;
  const data = body.data;

  const existing = await prisma.node.findUnique({
    where: { name_type: { name: data.name, type: data.type } },
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
  return json({ node: redactNode(node) }, 201);
}
