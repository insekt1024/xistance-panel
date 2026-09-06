import { z } from "zod";
import { prisma } from "@xistance/db";
import { requireSession, apiError, json } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { cached } from "@/lib/query-cache";

const HOUR_MS = 3600_000;

const RANGE_MS: Record<string, number> = {
  "1h": HOUR_MS,
  "6h": 6 * HOUR_MS,
  "24h": 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
};

const BUCKET_MS: Record<string, number> = {
  "1h": 60_000,
  "6h": 5 * 60_000,
  "24h": 30 * 60_000,
  "7d": 4 * HOUR_MS,
};

const Schema = z.object({
  range: z.enum(["1h", "6h", "24h", "7d"]).default("24h"),
});

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await requireSession(req);
  if (!session.ok) return session.response;
  const rl = rateLimit(`traffic:${session.user.id}`, 30, 60_000);
  if (!rl.ok) return apiError("Too many requests, slow down", 429);

  const url = new URL(req.url);
  const parsed = Schema.safeParse({ range: url.searchParams.get("range") });
  if (!parsed.success) return apiError("Invalid range parameter");

  const { range } = parsed.data;

  const data = await cached(`traffic:${range}`, 15_000, async () => {
    const since = new Date(Date.now() - RANGE_MS[range]);
    const bucket = BUCKET_MS[range];

    const rawSamples = await prisma.trafficSample.findMany({
      where: { ts: { gte: since } },
      select: { bytesIn: true, bytesOut: true, ts: true },
      orderBy: { ts: "asc" },
    });

    const buckets = new Map<number, { ts: number; bytesIn: bigint; bytesOut: bigint }>();
    for (const r of rawSamples) {
      const key = Math.floor(r.ts.getTime() / bucket) * bucket;
      const b = buckets.get(key) ?? { ts: key, bytesIn: BigInt(0), bytesOut: BigInt(0) };
      b.bytesIn += r.bytesIn;
      b.bytesOut += r.bytesOut;
      buckets.set(key, b);
    }

    return [...buckets.values()]
      .sort((a, b) => a.ts - b.ts)
      .map((b) => ({
        ts: new Date(b.ts).toISOString(),
        bytesIn: Number(b.bytesIn),
        bytesOut: Number(b.bytesOut),
      }));
  });

  return json({ ok: true, data });
}
