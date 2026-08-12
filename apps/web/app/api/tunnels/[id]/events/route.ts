import { getEngine } from "@/lib/engine";
import { requireSession } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server-Sent Events stream for a tunnel's live logs.
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireSession(request);
  if (!auth.ok) return new Response(auth.response.body, { status: auth.response.status });

  const { id } = await ctx.params;
  const engine = getEngine();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* client gone */
        }
      };
      const unsubscribe = await engine.streamLogs(id, (line) =>
        send({ type: "log", line }),
      );
      // Immediate ping so the client establishes right away instead of waiting
      // for the first 15s heartbeat (idle/stopped tunnels otherwise look dead).
      send({ type: "ping" });
      const heartbeat = setInterval(() => send({ type: "ping" }), 15_000);
      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
