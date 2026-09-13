// ---------------------------------------------------------------------------
// Automatic source-port allocation for port-forward rules.
// Simple mode (default): the panel picks the first free port in AUTO_RANGE
// excluding tunnel listen ports + already-forwarded ports, so one click
// creates a working rule with zero conflicts. Advanced mode lets the user
// type any port — the API still 409s on collision (fail loudly, no silent
// double-bind that would crash the whole node group at deploy).
// ---------------------------------------------------------------------------

export const AUTO_PORT_START = 10000;
export const AUTO_PORT_END = 60000;

export function usedPortsOf(
  tunnelPorts: Array<number | null | undefined>,
  rulePorts: Array<number | null | undefined>,
): Set<number> {
  const used = new Set<number>();
  for (const p of [...tunnelPorts, ...rulePorts]) {
    if (typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535) used.add(p);
  }
  return used;
}

/** First free port in [start, end] not in `used`. Null when exhausted. */
export function findFreePort(
  used: Set<number> | number[],
  start = AUTO_PORT_START,
  end = AUTO_PORT_END,
): number | null {
  const taken = used instanceof Set ? used : new Set(used);
  const lo = Math.max(1, Math.min(start, end));
  const hi = Math.min(65535, Math.max(start, end));
  for (let p = lo; p <= hi; p++) {
    if (!taken.has(p)) return p;
  }
  return null;
}
