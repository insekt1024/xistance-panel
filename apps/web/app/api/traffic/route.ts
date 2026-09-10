import { z } from "zod";
import { requireSession, apiError, json } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { CACHE_TRAFFIC, cached } from "@/lib/query-cache";
import { aggregateTrafficSince } from "@/lib/traffic";

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
  const rangeRaw = url.searchParams.get("range") ?? undefined;
  const parsed = Schema.safeParse({ range: rangeRaw });
  if (!parsed.success) return apiError("Invalid range parameter");

  const { range } = parsed.data;

  const data = await cached(`${CACHE_TRAFFIC}${range}`, 15_000, () =>
    aggregateTrafficSince(new Date(Date.now() - RANGE_MS[range]), BUCKET_MS[range]),
  );

  return json({ ok: true, data });
}
