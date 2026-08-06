import { prisma, type Prisma } from "@xistance/db";
import { apiError, json, requireSession } from "@/lib/api";

// Full backup/restore. Secrets stay encrypted at rest (same XTENC_KEY required
// to restore), so this JSON is safe to move between panel installs that share
// the encryption key — e.g. an update/restore on the same server.

export async function GET(request: Request) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;

  const [users, nodes, tunnels, portForwards, webhooks, settings, trafficSamples] =
    await Promise.all([
      prisma.user.findMany(),
      prisma.node.findMany(),
      prisma.tunnel.findMany(),
      prisma.portForward.findMany(),
      prisma.notificationWebhook.findMany(),
      prisma.setting.findMany(),
      prisma.trafficSample.findMany({ take: 5000 }),
    ]);

  return json({
    backup: {
      version: 1,
      exportedAt: new Date().toISOString(),
      users,
      nodes,
      tunnels,
      portForwards,
      webhooks,
      settings,
      trafficSamples,
    },
  });
}

export async function POST(request: Request) {
  const auth = await requireSession(request, "SUPER_ADMIN");
  if (!auth.ok) return auth.response;

  interface BackupPayload {
    version?: number;
    users?: Prisma.UserCreateManyInput[];
    nodes?: Prisma.NodeCreateManyInput[];
    tunnels?: Prisma.TunnelCreateManyInput[];
    portForwards?: Prisma.PortForwardCreateManyInput[];
    webhooks?: Prisma.NotificationWebhookCreateManyInput[];
    settings?: Prisma.SettingCreateManyInput[];
  }
  let payload: BackupPayload;
  try {
    payload = (await request.json()).backup as BackupPayload;
  } catch {
    return apiError("Invalid backup payload", 400);
  }
  if (!payload || payload.version !== 1) {
    return apiError("Unsupported backup version", 400);
  }

  await prisma.$transaction([
    prisma.user.createMany({ data: payload.users ?? [] }),
    prisma.node.createMany({ data: payload.nodes ?? [] }),
    prisma.tunnel.createMany({ data: payload.tunnels ?? [] }),
    prisma.portForward.createMany({ data: payload.portForwards ?? [] }),
    prisma.notificationWebhook.createMany({ data: payload.webhooks ?? [] }),
    prisma.setting.createMany({ data: payload.settings ?? [] }),
  ]);
  return json({ ok: true });
}
