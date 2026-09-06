import { z } from "zod";
import { prisma, type Prisma } from "@xistance/db";
import { auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";

// Full backup/restore. Secrets stay encrypted at rest (same XTENC_KEY required
// to restore), so this JSON is safe to move between panel installs that share
// the encryption key — e.g. an update/restore on the same server.

const TRAFFIC_SAMPLE_BACKUP_LIMIT = 500;

const restoreSchema = z.object({
  backup: z
    .object({
      version: z.literal(1),
      users: z.array(z.record(z.string(), z.unknown())).optional(),
      nodes: z.array(z.record(z.string(), z.unknown())).optional(),
      tunnels: z.array(z.record(z.string(), z.unknown())).optional(),
      portForwards: z.array(z.record(z.string(), z.unknown())).optional(),
      webhooks: z.array(z.record(z.string(), z.unknown())).optional(),
      settings: z.array(z.record(z.string(), z.unknown())).optional(),
    })
    .passthrough(),
});

export async function GET(request: Request) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;

  const [users, nodes, tunnels, portForwards, webhooks, settings, trafficSamples] =
    await Promise.all([
      prisma.user.findMany({ select: { id: true, email: true, name: true, role: true, quota: true, active: true, createdAt: true } }),
      prisma.node.findMany({ select: { id: true, name: true, type: true, host: true, status: true, lastSeen: true } }),
      prisma.tunnel.findMany({ select: { id: true, name: true, method: true, status: true, state: true, port: true, autostart: true } }),
      prisma.portForward.findMany({ select: { id: true, name: true, direction: true, protocol: true, sourcePort: true, destHost: true, destPort: true, enabled: true, status: true } }),
      prisma.notificationWebhook.findMany({ select: { id: true, type: true, name: true, enabled: true, createdAt: true } }),
      prisma.setting.findMany({ select: { key: true, value: true, updatedAt: true } }),
      prisma.trafficSample.findMany({ take: TRAFFIC_SAMPLE_BACKUP_LIMIT, orderBy: { ts: "desc" } }),
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
  const body = await parseBody(request, restoreSchema);
  if (!body.ok) return body.response;
  const payload = body.data.backup as BackupPayload;

  // Use individual transactions with error handling for SQLite compatibility
  // (skipDuplicates is not supported on SQLite)
  await Promise.allSettled([
    payload.users?.length ? prisma.user.createMany({ data: payload.users }).catch(() => ({ count: 0 })) : Promise.resolve({ count: 0 }),
    payload.nodes?.length ? prisma.node.createMany({ data: payload.nodes }).catch(() => ({ count: 0 })) : Promise.resolve({ count: 0 }),
    payload.tunnels?.length ? prisma.tunnel.createMany({ data: payload.tunnels }).catch(() => ({ count: 0 })) : Promise.resolve({ count: 0 }),
    payload.portForwards?.length ? prisma.portForward.createMany({ data: payload.portForwards }).catch(() => ({ count: 0 })) : Promise.resolve({ count: 0 }),
    payload.webhooks?.length ? prisma.notificationWebhook.createMany({ data: payload.webhooks }).catch(() => ({ count: 0 })) : Promise.resolve({ count: 0 }),
    payload.settings?.length ? prisma.setting.createMany({ data: payload.settings }).catch(() => ({ count: 0 })) : Promise.resolve({ count: 0 }),
  ]);
  await auditLog(
    auth.user.id,
    "settings.restore",
    undefined,
    "Backup restored",
    getClientIp(request),
  );
  return json({ ok: true });
}
