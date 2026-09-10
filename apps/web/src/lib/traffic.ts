import { prisma } from "@xistance/db";

// ---------------------------------------------------------------------------
// Traffic aggregation shared by the dashboard section and /api/traffic.
//
// The sampler stamps every row it writes in one tick with the same `ts`
// (see lib/sampler.ts — `now` is captured once per tick), so the database can
// collapse the per-tunnel rows before they cross the wire. Summing in SQL
// instead of loading every sample and reducing in JS bounds the result set at
// one row per tick regardless of how many tunnels are managed:
//
//   7d range, 60s sampling, 50 tunnels
//     before: 50 x 10,080 = 504,000 rows loaded, summed in JS
//     after :      10,080 rows loaded (index-backed by @@index([ts]))
//
// Both reads are index-backed by TrafficSample.@@index([ts]).
// ---------------------------------------------------------------------------

export interface TrafficPoint {
  ts: string;
  bytesIn: number;
  bytesOut: number;
}

/**
 * Prisma types BigInt sums as `bigint | null`, but SQLite can hand back a
 * plain number for a SUM(). Normalise both shapes so the bucket arithmetic
 * below never mixes BigInt and Number (which throws at runtime).
 */
function toBigInt(value: bigint | number | null | undefined): bigint {
  if (value == null) return BigInt(0);
  return typeof value === "bigint" ? value : BigInt(Math.floor(value));
}

/**
 * Total bytes in/out per `bucketMs` window since `since`, oldest first.
 */
export async function aggregateTrafficSince(
  since: Date,
  bucketMs: number,
): Promise<TrafficPoint[]> {
  const ticks = await prisma.trafficSample.groupBy({
    by: ["ts"],
    where: { ts: { gte: since } },
    _sum: { bytesIn: true, bytesOut: true },
    orderBy: { ts: "asc" },
  });

  const buckets = new Map<number, { ts: number; bytesIn: bigint; bytesOut: bigint }>();
  for (const tick of ticks) {
    const key = Math.floor(tick.ts.getTime() / bucketMs) * bucketMs;
    const b = buckets.get(key) ?? { ts: key, bytesIn: BigInt(0), bytesOut: BigInt(0) };
    b.bytesIn += toBigInt(tick._sum.bytesIn);
    b.bytesOut += toBigInt(tick._sum.bytesOut);
    buckets.set(key, b);
  }

  return [...buckets.values()]
    .sort((a, b) => a.ts - b.ts)
    .map((b) => ({
      ts: new Date(b.ts).toISOString(),
      bytesIn: Number(b.bytesIn),
      bytesOut: Number(b.bytesOut),
    }));
}
