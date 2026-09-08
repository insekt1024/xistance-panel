import { z } from "zod";
import { prisma } from "@xistance/db";
import { TunnelConfigSchema, type TunnelConfig } from "@xistance/types";
import { apiError, auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";
import { getEngine } from "@/lib/engine";
import { buildSpec, storeTunnelConfig } from "@/lib/tunnels";
import { rateLimit } from "@/lib/rate-limit";
import { invalidateCache } from "@/lib/query-cache";

const tunnelCreateSchema = z.object({
  // No line breaks: names flow into systemd unit Descriptions.
  name: z.string().min(1).max(80).regex(/^[^\r\n]*$/, "Name must not contain line breaks"),
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

const LIST_LIMIT = 50;

export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const { searchParams } = new URL(request.url);
  const cursor = searchParams.get("cursor") ? { id: searchParams.get("cursor")! } : undefined;
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || LIST_LIMIT, 1), 100);
  // Ownerless (ownerId null) tunnels 403 on detail for USER, so don't list them either.
  const where = auth.user.role === "USER" ? { ownerId: auth.user.id } : {};
  let tunnels;
  try {
    tunnels = await prisma.tunnel.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor } : {}),
      select: {
        id: true,
        name: true,
        method: true,
        status: true,
        state: true,
        port: true,
        autostart: true,
        clientNode: { select: { id: true, name: true, type: true } },
        serverNode: { select: { id: true, name: true, type: true } },
        owner: { select: { id: true, name: true, email: true } },
      },
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2025" || /cursor/i.test((err as Error).message ?? "")) {
      return apiError("Invalid cursor", 400);
    }
    throw err;
  }
  const hasNext = tunnels.length > limit;
  const items = hasNext ? tunnels.slice(0, limit) : tunnels;
  const nextCursor = hasNext ? items[items.length - 1].id : null;
  return json({ tunnels: items, hasNext, nextCursor });
}

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const rl = rateLimit(`tunnels-create:${auth.user.id}`, 10, 60_000);
  if (!rl.ok) return apiError("Too many create requests, slow down", 429);

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

  const nodeSelect = {
    id: true, host: true, sshUser: true, sshPort: true,
    authMethod: true, sshKeyEncrypted: true, sshPasswordEnc: true,
  } as const;
  const [clientNode, serverNode] = await Promise.all([
    prisma.node.findUnique({ where: { id: data.clientNodeId }, select: nodeSelect }),
    prisma.node.findUnique({ where: { id: data.serverNodeId }, select: nodeSelect }),
  ]);
  if (!clientNode || !serverNode) return apiError("One or both nodes not found", 404);
  if (clientNode.id === serverNode.id) {
    return apiError("Client and server nodes must be different", 422);
  }

  const port = extractPort(data.config);
  if (port !== null) {
    const conflicting = await prisma.tunnel.findFirst({
      where: { port, status: { in: ["running", "starting"] } },
      select: { id: true, name: true },
    });
    if (conflicting) {
      return apiError(`Port ${port} is already in use by tunnel "${conflicting.name}"`, 409);
    }
  }

  // Create-first-then-deploy: the DB row owns the tunnel lifecycle, so a
  // failed deploy leaves a visible "starting → stopped + errorMessage" row
  // instead of a ghost running process with no record.
  const id = crypto.randomUUID();
  const tunnel = await prisma.tunnel.create({
    data: {
      id,
      name: data.name,
      method: data.config.method,
      status: "starting",
      state: "starting",
      clientNodeId: data.clientNodeId,
      serverNodeId: data.serverNodeId,
      ownerId: auth.user.id,
      config: storeTunnelConfig(data.config),
      port: extractPort(data.config),
      autostart: data.autostart,
    },
  });
  const failCreate = async (message: string) => {
    await prisma.tunnel.update({
      where: { id },
      data: { status: "stopped", state: "stopped", errorMessage: message },
    }).catch(() => {});
    invalidateCache();
    return apiError(message, 500);
  };

  let spec;
  try {
    spec = await buildSpec(
      id,
      data.name,
      data.config.method,
      data.config,
      clientNode,
      serverNode,
    );
  } catch {
    return failCreate("Failed to decrypt node credentials");
  }

  try {
    await getEngine().deploy(spec);
  } catch (err) {
    return failCreate(`Deploy failed: ${(err as Error).message}`);
  }

  const created = await prisma.tunnel.update({
    where: { id },
    data: { status: "running", state: "running", errorMessage: null },
  });
  await auditLog(auth.user.id, "tunnel.create", created.id, created.name, getClientIp(request));
  invalidateCache();
  // Don't leak the stored config ciphertext to non-admin callers.
  if (auth.user.role === "USER") {
    const { config: _config, ...safeTunnel } = created;
    void _config;
    return json({ tunnel: safeTunnel }, 201);
  }
  return json({ tunnel: created }, 201);
}
