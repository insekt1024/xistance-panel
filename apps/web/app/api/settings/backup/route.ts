import { z } from "zod";
import { prisma, type Prisma } from "@xistance/db";
import { apiError, auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { invalidateCache } from "@/lib/query-cache";
import { redactTunnelConfig } from "@/lib/tunnels";
import { releaseAudit } from "@/lib/release-audit";
import { APP_VERSION } from "@/lib/version";

// Full backup/restore.
//
// Node credentials are ciphertext (XTENC_KEY required to read them), so moving
// them between panel installs that share the key is safe. Tunnel configs are
// NOT: their tokens are stored in plaintext because the engine has to hand
// them to a process at start time. Exporting a config blob verbatim therefore
// hands out every tunnel credential in the install -- to whoever receives the
// file, into any ticket it is pasted into, and into any repo it is committed
// to. They are redacted on the way out; the PRD forbids exposing them in
// backups presented in the UI.
//
// A redacted config is still restorable: the secret fields keep their KEYS with
// a "***" value, so a restore knows a credential was set. Restoring one onto a
// fresh install will therefore not carry the credential across -- re-enter it
// for the tunnels that need it. That is the deliberate trade: a backup that
// cannot silently restore a credential is worth more than one that can.

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
  const rl = rateLimit(`settings-backup:${auth.user.id}`, 10, 60_000);
  if (!rl.ok) return apiError("Too many requests, slow down", 429);

  const [users, nodes, tunnels, portForwards, webhooks, settings, trafficSamples] =
    await Promise.all([
      prisma.user.findMany({ select: { id: true, email: true, name: true, role: true, quota: true, active: true, createdAt: true } }),
      // Credential ciphertext is NOT exported. These columns are AES-256-GCM
      // under XTENC_KEY, so they are unreadable on their own — but a backup file
      // that travels by email or a USB stick should not be one master-key
      // recovery away from every node credential in the deployment. Export the
      // shape (which credentials exist) so the operator knows what must be
      // re-entered after a restore, and nothing more. This mirrors
      // redactNode() in lib/tunnels.ts, which already strips these columns from
      // API responses. The filesystem-level `tar` of /var/lib/xistance remains
      // the complete backup, and it keeps the ciphertext.
      prisma.node.findMany({ select: { id: true, name: true, type: true, host: true, status: true, lastSeen: true } }),
      prisma.tunnel.findMany({ select: { id: true, name: true, method: true, status: true, state: true, port: true, autostart: true, config: true, clientNodeId: true, serverNodeId: true } }),
      prisma.portForward.findMany({ select: { id: true, name: true, direction: true, protocol: true, sourcePort: true, destHost: true, destPort: true, enabled: true, status: true } }),
      prisma.notificationWebhook.findMany({ select: { id: true, type: true, name: true, url: true, events: true, enabled: true, createdAt: true } }),
      prisma.setting.findMany({ select: { key: true, value: true, updatedAt: true } }),
      prisma.trafficSample.findMany({
        take: TRAFFIC_SAMPLE_BACKUP_LIMIT,
        orderBy: { ts: "desc" },
        select: { ts: true, tunnelId: true, bytesIn: true, bytesOut: true },
      }),
    ]);

  // A backup export is recovery PREPARATION, and it is the one release-lifecycle
  // action the panel itself performs. Recorded under the release vocabulary so an
  // incident review can see "backed up, then updated, then rolled back" as one
  // timeline instead of two unrelated vocabularies. The existing
  // `settings.backup-export` row stays: that is the operator-facing action, and
  // this is the recovery-history one.
  await releaseAudit.restored({
    version: APP_VERSION,
    actorId: auth.user.id,
    ip: getClientIp(request),
  });
  await auditLog(auth.user.id, "settings.backup-export", undefined, undefined, getClientIp(request));

  return json({
    backup: {
      version: 1,
      exportedAt: new Date().toISOString(),
      users,
      nodes,
      // Configs are redacted: see the note at the top of this file.
      tunnels: tunnels.map((t) => ({ ...t, config: redactTunnelConfig(t.config) })),
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

  // Use individual operations for SQLite compatibility
  // (skipDuplicates is not supported on SQLite)
  const ops: { label: string; run: () => Promise<unknown> }[] = [
    { label: "users", run: () => (payload.users?.length ? prisma.user.createMany({ data: payload.users }) : Promise.resolve({ count: 0 })) },
    { label: "nodes", run: () => (payload.nodes?.length ? prisma.node.createMany({ data: payload.nodes }) : Promise.resolve({ count: 0 })) },
    { label: "tunnels", run: () => (payload.tunnels?.length ? prisma.tunnel.createMany({ data: payload.tunnels }) : Promise.resolve({ count: 0 })) },
    { label: "portForwards", run: () => (payload.portForwards?.length ? prisma.portForward.createMany({ data: payload.portForwards }) : Promise.resolve({ count: 0 })) },
    { label: "webhooks", run: () => (payload.webhooks?.length ? prisma.notificationWebhook.createMany({ data: payload.webhooks }) : Promise.resolve({ count: 0 })) },
    { label: "settings", run: () => (payload.settings?.length ? prisma.setting.createMany({ data: payload.settings }) : Promise.resolve({ count: 0 })) },
  ];
  const settled = await Promise.allSettled(ops.map((o) => o.run()));
  const errors = settled.flatMap((r, i) =>
    r.status === "rejected" ? [`${ops[i].label}: ${(r.reason as Error)?.message ?? "restore failed"}`] : [],
  );
  const attempted = [payload.users, payload.nodes, payload.tunnels, payload.portForwards, payload.webhooks, payload.settings].filter(
    (a) => a?.length,
  ).length;
  // Restore rewrites whole tables, so every cached read is suspect —
  // this is the one place a full, unscoped clear is correct.
  invalidateCache();
  if (attempted > 0 && errors.length >= attempted) {
    return apiError(`Restore failed: ${errors.join("; ")}`, 500);
  }
  await auditLog(
    auth.user.id,
    "settings.restore",
    undefined,
    errors.length > 0 ? `Backup partially restored: ${errors.join("; ")}` : "Backup restored",
    getClientIp(request),
  );
  if (errors.length > 0) {
    return json({ ok: true, partial: true, errors });
  }
  return json({ ok: true });
}
