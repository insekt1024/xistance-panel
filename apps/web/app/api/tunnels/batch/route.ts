import { z } from "zod";
import { prisma } from "@xistance/db";
import { apiError, json, parseBody, requireSession, auditLog, getClientIp } from "@/lib/api";
import { getEngine } from "@/lib/engine";
import { buildDeploySpec } from "@/lib/tunnels";
import { rateLimit } from "@/lib/rate-limit";

const batchSchema = z.object({
  action: z.enum(["start", "stop", "restart"]),
  tunnelIds: z.array(z.string().uuid()).min(1).max(20),
});

const STATE = {
  start: "running",
  stop: "stopped",
  restart: "running",
} as const;

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const rl = rateLimit(`batch-action:${auth.user.id}`, 10, 60_000);
  if (!rl.ok) return apiError("Too many batch requests, slow down", 429);

  const body = await parseBody(request, batchSchema);
  if (!body.ok) return body.response;
  const { action, tunnelIds } = body.data;

  const tunnels = await prisma.tunnel.findMany({
    where: { id: { in: tunnelIds } },
    select: {
      id: true,
      name: true,
      ownerId: true,
      method: true,
      clientNodeId: true,
      serverNodeId: true,
    },
  });

  if (tunnels.length === 0) return apiError("No tunnels found", 404);

  // RBAC: USER can only act on own tunnels
  const owned = tunnels.filter(
    (t) => auth.user.role !== "USER" || t.ownerId === auth.user.id,
  );
  const forbidden = tunnels.length - owned.length;

  const engine = getEngine();
  const results: { id: string; ok: boolean; error?: string }[] = [];

  // Process tunnels sequentially to avoid overwhelming SSH
  for (const tunnel of owned) {
    const hasTunnel = engine.has(tunnel.id);
    try {
      if (!hasTunnel) {
        if (action === "stop") {
          await prisma.tunnel.update({
            where: { id: tunnel.id },
            data: { state: "stopped", status: "stopped" },
          });
          results.push({ id: tunnel.id, ok: true });
          continue;
        }
        // Deploy before starting/restarting
        const [withConfig, client, server] = await Promise.all([
          prisma.tunnel.findUnique({
            where: { id: tunnel.id },
            select: { id: true, name: true, method: true, config: true, clientNodeId: true, serverNodeId: true },
          }),
          prisma.node.findUnique({
            where: { id: tunnel.clientNodeId ?? "" },
            select: { id: true, host: true, sshUser: true, sshPort: true, authMethod: true, sshKeyEncrypted: true, sshPasswordEnc: true },
          }),
          prisma.node.findUnique({
            where: { id: tunnel.serverNodeId ?? "" },
            select: { id: true, host: true, sshUser: true, sshPort: true, authMethod: true, sshKeyEncrypted: true, sshPasswordEnc: true },
          }),
        ]);
        if (!withConfig) {
          results.push({ id: tunnel.id, ok: false, error: "Tunnel config not found" });
          continue;
        }
        await engine.deploy(await buildDeploySpec(withConfig, client, server));
      }

      if (action === "start") await engine.start(tunnel.id);
      else if (action === "stop") await engine.stop(tunnel.id);
      else await engine.restart(tunnel.id);

      const state = STATE[action];
      await prisma.tunnel.update({
        where: { id: tunnel.id },
        data: { state, status: state, errorMessage: null },
      });
      results.push({ id: tunnel.id, ok: true });
    } catch (err) {
      results.push({ id: tunnel.id, ok: false, error: (err as Error).message || "Action failed" });
    }
  }

  // Add forbidden entries
  const forbiddenIds = tunnels.filter((t) => !owned.includes(t)).map((t) => t.id);
  for (const id of forbiddenIds) {
    results.push({ id, ok: false, error: "Forbidden" });
  }

  // Add not-found entries
  const foundIds = new Set(tunnels.map((t) => t.id));
  for (const id of tunnelIds) {
    if (!foundIds.has(id)) {
      results.push({ id, ok: false, error: "Tunnel not found" });
    }
  }

  await auditLog(auth.user.id, `tunnel.batch.${action}`, undefined, `ids: ${tunnelIds.join(",")}`, getClientIp(request));

  return json({
    ok: results.every((r) => r.ok),
    results,
    summary: {
      total: tunnelIds.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      forbidden,
    },
  });
}
