import { z } from "zod";
import { prisma } from "@xistance/db";
import { apiError, auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";
import { getEngine } from "@/lib/engine";
import { buildDeploySpec } from "@/lib/tunnels";
import { rateLimit } from "@/lib/rate-limit";
import { CACHE_METRICS, invalidateCache } from "@/lib/query-cache";

const actionSchema = z.object({
  action: z.enum(["start", "stop", "restart"]),
});

const STATE = {
  start: "running",
  stop: "stopped",
  restart: "running",
} as const;

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  // Prevent rapid-fire start/stop toggling which hammers SSH sessions.
  const rl = rateLimit(`tunnel-action:${auth.user.id}`, 30, 60_000);
  if (!rl.ok) return apiError("Too many tunnel actions, slow down", 429);
  const { id } = await ctx.params;

  const body = await parseBody(request, actionSchema);
  if (!body.ok) return body.response;
  const { action } = body.data;

  const engine = getEngine();
  const hasTunnel = engine.has(id);

   // Fetch only what we need for authorization check
   const tunnel = await prisma.tunnel.findUnique({
     where: { id },
     select: { id: true, name: true, ownerId: true, port: true, clientNodeId: true, serverNodeId: true, method: true },
   });
   if (!tunnel) return apiError("Tunnel not found", 404);
   if (auth.user.role === "USER" && tunnel.ownerId !== auth.user.id) {
     return apiError("Forbidden", 403);
   }

    // Port-conflict check mirrors create: refuse to start when another
    // running/starting tunnel already holds the port.
    // NOTE: check-then-act leaves a residual race under concurrent starts;
    // acceptable — the engine deploy/start path is the final arbiter.
    if ((action === "start" || action === "restart") && tunnel.port != null) {
      const conflicting = await prisma.tunnel.findFirst({
        where: { port: tunnel.port, status: { in: ["running", "starting"] }, NOT: { id } },
        select: { id: true, name: true },
      });
      if (conflicting) {
        return apiError(`Port ${tunnel.port} is already in use by tunnel "${conflicting.name}"`, 409);
      }
    }

    if (!hasTunnel) {
      if (action === "stop") {
        await prisma.tunnel.update({ where: { id }, data: { state: "stopped", status: "stopped" } });
        return json({ ok: true });
      }
      const { clientNodeId, serverNodeId } = tunnel;
      if (!clientNodeId || !serverNodeId) {
        return apiError("Tunnel has no nodes assigned", 422);
      }
      // Fetch config and node records in parallel when deploying (avoids sequential round-trips)
      const [withConfig, client, server] = await Promise.all([
        prisma.tunnel.findUnique({
          where: { id },
          select: { id: true, name: true, method: true, config: true, clientNodeId: true, serverNodeId: true },
        }),
        prisma.node.findUnique({
          where: { id: clientNodeId },
          select: { id: true, host: true, sshUser: true, sshPort: true, authMethod: true, sshKeyEncrypted: true, sshPasswordEnc: true },
        }),
        prisma.node.findUnique({
          where: { id: serverNodeId },
          select: { id: true, host: true, sshUser: true, sshPort: true, authMethod: true, sshKeyEncrypted: true, sshPasswordEnc: true },
        }),
      ]);
     if (!withConfig) return apiError("Tunnel not found", 404);
     await engine.deploy(await buildDeploySpec(withConfig, client, server));
   }

  try {
    if (action === "start") await engine.start(id);
    else if (action === "stop") await engine.stop(id);
    else await engine.restart(id);
  } catch (err) {
    return apiError((err as Error).message || "Action failed", 500);
  }

  const state = STATE[action];
  await prisma.tunnel.update({
    where: { id },
    data: { state, status: state, errorMessage: null },
  });
  await auditLog(auth.user.id, `tunnel.${action}`, id, tunnel.name, getClientIp(request));
  invalidateCache(CACHE_METRICS);
  return json({ ok: true, state });
}
