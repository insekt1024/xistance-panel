import { getEngine } from "@/lib/engine";
import { json, requireSession } from "@/lib/api";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const lines = getEngine().has(id) ? await getEngine().recentLogs(id, 300) : [];
  return json({ lines });
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const snap = getEngine().has(id) ? await getEngine().snapshot(id) : null;
  return json({ snapshot: snap });
}
