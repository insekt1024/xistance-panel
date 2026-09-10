import { z } from "zod";
import { prisma } from "@xistance/db";
import { apiError, json, parseBody, requireSession, auditLog, getClientIp } from "@/lib/api";
import { getEngine } from "@/lib/engine";
import { buildDeploySpec } from "@/lib/tunnels";
import { rateLimit } from "@/lib/rate-limit";
import { CACHE_METRICS, invalidateCache } from "@/lib/query-cache";

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

  const whereFilter = auth.user.role === "USER"
    ? { id: { in: tunnelIds }, ownerId: auth.user.id }
    : { id: { in: tunnelIds } };

  const tunnels = await prisma.tunnel.findMany({
    where: whereFilter,
    select: {
      id: true,
      name: true,
      ownerId: true,
      method: true,
      port: true,
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

  // Prefetch tunnel configs + nodes before the loop instead of per-tunnel
  const nodeSelect = { id: true, host: true, sshUser: true, sshPort: true, authMethod: true, sshKeyEncrypted: true, sshPasswordEnc: true } as const;
  const configIds = owned.filter((t) => !engine.has(t.id) && action !== "stop").map((t) => t.id);
  const nodeIds = [...new Set(
    owned.filter((t) => !engine.has(t.id) && action !== "stop")
      .flatMap((t) => [t.clientNodeId, t.serverNodeId].filter(Boolean) as string[]),
  )];

  const [tunnelConfigs, nodes] = await Promise.all([
    configIds.length > 0
      ? prisma.tunnel.findMany({
          where: { id: { in: configIds } },
          select: { id: true, name: true, method: true, config: true, clientNodeId: true, serverNodeId: true },
        })
      : Promise.resolve([]),
    nodeIds.length > 0
      ? prisma.node.findMany({
          where: { id: { in: nodeIds } },
          select: nodeSelect,
        })
      : Promise.resolve([]),
  ]);

  const configMap = new Map(tunnelConfigs.map((c) => [c.id, c]));
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // Process tunnels sequentially to avoid overwhelming SSH
  for (const tunnel of owned) {
    const hasTunnel = engine.has(tunnel.id);
    // Port-conflict check mirrors create: refuse to start when another
    // running/starting tunnel already holds the port.
    // NOTE: check-then-act leaves a residual race under concurrent starts;
    // acceptable — the engine deploy/start path is the final arbiter.
    if (action !== "stop" && tunnel.port != null) {
      const conflicting = await prisma.tunnel.findFirst({
        where: { port: tunnel.port, status: { in: ["running", "starting"] }, NOT: { id: tunnel.id } },
        select: { id: true, name: true },
      });
      if (conflicting) {
        results.push({ id: tunnel.id, ok: false, error: `Port ${tunnel.port} is already in use by tunnel "${conflicting.name}"` });
        continue;
      }
    }
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
        // Deploy before starting/restarting — use prefetched data
        const withConfig = configMap.get(tunnel.id) ?? null;
        const client = tunnel.clientNodeId ? nodeMap.get(tunnel.clientNodeId) ?? null : null;
        const server = tunnel.serverNodeId ? nodeMap.get(tunnel.serverNodeId) ?? null : null;
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
      results.push({ id, ok: false, error: "Tunnel not found or access denied" });
    }
  }

  await auditLog(auth.user.id, `tunnel.batch.${action}`, undefined, `ids: ${tunnelIds.join(",")}`, getClientIp(request));
  invalidateCache(CACHE_METRICS);

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
