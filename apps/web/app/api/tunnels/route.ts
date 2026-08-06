import { z } from "zod";
import { prisma } from "@xistance/db";
import { TunnelConfigSchema, type TunnelConfig } from "@xistance/types";
import { apiError, auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";
import { getEngine } from "@/lib/engine";
import { buildSpec, storeTunnelConfig } from "@/lib/tunnels";

const tunnelCreateSchema = z.object({
  name: z.string().min(1).max(80),
  clientNodeId: z.string().uuid(),
  serverNodeId: z.string().uuid(),
  config: TunnelConfigSchema,
  autostart: z.boolean().default(false),
});

export function extractPort(config: TunnelConfig): number | null {
  switch (config.method) {
    case "BACKHAUL":
      return config.backhaul.listenPort;
    case "FRP":
      return config.frp.bindPort;
    case "GOST":
      return config.gost.listenPort;
    case "SSH":
      return config.ssh.localPort;
    case "PORT_FORWARD":
      return config.portForwards[0]?.sourcePort ?? null;
  }
}

export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  const where =
    auth.user.role === "USER"
      ? { OR: [{ ownerId: auth.user.id }, { ownerId: null }] }
      : {};
  const tunnels = await prisma.tunnel.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      clientNode: { select: { id: true, name: true, type: true } },
      serverNode: { select: { id: true, name: true, type: true } },
      owner: { select: { id: true, name: true, email: true } },
    },
  });
  return json({ tunnels });
}

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  const body = await parseBody(request, tunnelCreateSchema);
  if (!body.ok) return body.response;
  const data = body.data;

  if (auth.user.role === "USER") {
    const active = await prisma.tunnel.count({
      where: { ownerId: auth.user.id, status: { in: ["running", "starting"] } },
    });
    if (active >= auth.user.quota) {
      return apiError("Tunnel quota reached", 403);
    }
  }

  const [clientNode, serverNode] = await Promise.all([
    prisma.node.findUnique({ where: { id: data.clientNodeId } }),
    prisma.node.findUnique({ where: { id: data.serverNodeId } }),
  ]);
  if (!clientNode || !serverNode) return apiError("One or both nodes not found", 404);
  if (clientNode.id === serverNode.id) {
    return apiError("Client and server nodes must be different", 422);
  }

  const spec = await buildSpec(
    crypto.randomUUID(),
    data.name,
    data.config.method,
    data.config,
    clientNode,
    serverNode,
  );

  try {
    await getEngine().deploy(spec);
  } catch (err) {
    return apiError(`Deploy failed: ${(err as Error).message}`, 500);
  }

  const tunnel = await prisma.tunnel.create({
    data: {
      id: spec.id,
      name: data.name,
      method: data.config.method,
      status: "running",
      state: "running",
      clientNodeId: data.clientNodeId,
      serverNodeId: data.serverNodeId,
      ownerId: auth.user.id,
      config: storeTunnelConfig(data.config),
      port: extractPort(data.config),
      autostart: data.autostart,
    },
  });
  await auditLog(auth.user.id, "tunnel.create", tunnel.id, tunnel.name, getClientIp(request));
  return json({ tunnel }, 201);
}
