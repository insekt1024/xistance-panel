import { z } from "zod";
import { prisma } from "@xistance/db";
import { apiError, json, parseBody, requireSession } from "@/lib/api";
import { getEngine } from "@/lib/engine";
import { buildDeploySpec } from "@/lib/tunnels";

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
  const { id } = await ctx.params;
  const tunnel = await prisma.tunnel.findUnique({ where: { id } });
  if (!tunnel) return apiError("Tunnel not found", 404);
  if (auth.user.role === "USER" && tunnel.ownerId !== auth.user.id) {
    return apiError("Forbidden", 403);
  }

  const body = await parseBody(request, actionSchema);
  if (!body.ok) return body.response;
  const { action } = body.data;

  const engine = getEngine();
  if (!engine.has(id)) {
    if (action === "stop") {
      await prisma.tunnel.update({ where: { id }, data: { state: "stopped", status: "stopped" } });
      return json({ ok: true });
    }
    const [client, server] = await Promise.all([
      prisma.node.findUnique({ where: { id: tunnel.clientNodeId ?? "" } }),
      prisma.node.findUnique({ where: { id: tunnel.serverNodeId ?? "" } }),
    ]);
    await engine.deploy(await buildDeploySpec(tunnel, client, server));
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
  return json({ ok: true, state });
}
