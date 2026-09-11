// ---------------------------------------------------------------------------
// Bounded-concurrency map.
//
// Engine calls (status/snapshot) can each open an SSH session on a remote
// node, so `Promise.all(items.map(fn))` over every tunnel is a thundering
// herd — one burst per page render, and the dashboard re-renders every 30s.
// A small worker pool keeps the fan-out flat while preserving input order.
// ---------------------------------------------------------------------------

/** Default fan-out for engine calls: matches the traffic sampler's cap. */
export const ENGINE_CONCURRENCY = 5;

export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length) as R[];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        out[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return out;
}
