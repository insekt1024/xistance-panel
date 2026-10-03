import { prisma } from "@xistance/db";
import { getEngine } from "@/lib/engine";
import { apiError, requireSession } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bounded, sanitised diagnostic history for one tunnel.
 *
 * Additive: the existing tunnel payloads are unchanged, so this is a new
 * endpoint rather than new required fields on an existing response. The
 * authorization model matches the sibling events/logs routes exactly -- owner
 * or elevated role, 404 for unknown, 403 for someone else's tunnel.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const tunnel = await prisma.tunnel.findUnique({
    where: { id },
    select: { ownerId: true },
  });
  if (!tunnel) return apiError("Tunnel not found", 404);
  if (auth.user.role === "USER" && tunnel.ownerId !== auth.user.id) {
    return apiError("Forbidden", 403);
  }

  const engine = getEngine();
  return Response.json({
    latest: engine.getDiagnostic(id),
    history: engine.listDiagnostics(id),
  });
}
