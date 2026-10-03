import net from "node:net";

// ---------------------------------------------------------------------------
// Automatic source-port allocation for port-forward rules.
//
// Simple mode (default): the panel picks the first free port in the auto range
// excluding tunnel listen ports + already-forwarded ports, so one click creates
// a working rule with zero conflicts. Advanced mode lets the user type any port
// -- the API still 409s on collision (fail loudly, no silent double-bind that
// would crash the whole node group at deploy).
//
// Two distinct failure modes are represented, because conflating them is what
// makes the panel report "something went wrong" instead of something an
// operator can act on:
//   - the RANGE is exhausted (nothing left in [start, end]);
//   - the specific PORT is CONFLICTED (a rule, a tunnel, or another process on
//     the host already holds it).
//
// Reservation strategy (see TASK-24's note): an OS-level check is NOT atomic.
// Binding a probe socket to test availability, releasing it, and returning the
// number leaves a window in which another process can take the port. This
// module therefore does not claim to prevent that race -- it does two things
// that are actually achievable:
//   1. `isPortOccupied` is injected and checked, so a port held by a process
//      outside the panel is skipped rather than handed out and failing later;
//   2. `allocatePorts` serialises a BATCH through a single reservation pass,
//      so N allocations in one request can never return the same port twice.
// The residual race (a foreign process binding between check and use) is
// narrowed, not eliminated, and is reported as a PortConflictError at bind
// time rather than silently double-binding.
// ---------------------------------------------------------------------------

export const AUTO_PORT_START = 10000;
export const AUTO_PORT_END = 60000;

/** Stable, machine-readable codes so the UI can branch without string matching. */
export const PORT_ERROR_CODES = {
  CONFLICT: "PORT_CONFLICT",
  RANGE_EXHAUSTED: "PORT_RANGE_EXHAUSTED",
  INVALID_RANGE: "PORT_INVALID_RANGE",
} as const;

export class PortConflictError extends Error {
  readonly code = PORT_ERROR_CODES.CONFLICT;
  constructor(
    readonly port: number,
    readonly protocol: string,
    readonly holder: string = "another rule",
  ) {
    super(
      `Port ${port}/${protocol} is already in use by ${holder} — pick another port or edit that rule`,
    );
    this.name = "PortConflictError";
  }
}

export class PortRangeExhaustedError extends Error {
  readonly code = PORT_ERROR_CODES.RANGE_EXHAUSTED;
  constructor(readonly start: number, readonly end: number) {
    super(`No free ports left in the auto range ${start}-${end}`);
    this.name = "PortRangeExhaustedError";
  }
}

export class PortRangeInvalidError extends Error {
  readonly code = PORT_ERROR_CODES.INVALID_RANGE;
  constructor(readonly start: number, readonly end: number) {
    super(`Invalid port range ${start}-${end}`);
    this.name = "PortRangeInvalidError";
  }
}

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

/**
 * True when a port is already bound by something on this host.
 *
 * Two forms exist deliberately. `SyncPortOccupancyProbe` lets the allocation
 * tests be exhaustive and deterministic without binding tens of thousands of
 * sockets; `PortOccupancyProbe` is the real OS probe and requires the async
 * entry points. Mixing them was a bug: the sync path silently accepted a
 * promise and treated it as "not occupied", handing out a busy port.
 */
export type SyncPortOccupancyProbe = (port: number) => boolean;
export type PortOccupancyProbe = (port: number) => Promise<boolean>;

/**
 * Probe the OS for a bound port.
 *
 * Uses a real bind attempt rather than parsing `ss`/`netstat`: parsing is
 * platform-specific, racy, and often unavailable in a slim container. A bind
 * that fails means occupied; a bind that succeeds means free, and is released
 * immediately.
 *
 * Any probe error is reported as occupied. That is the safe direction: skipping
 * a port that is actually free costs the user one number, while handing out a
 * busy port fails at a much later and more confusing point.
 */
export const isPortOccupied: PortOccupancyProbe = async (port: number): Promise<boolean> => {
  return new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    const done = (occupied: boolean): void => {
      probe.removeAllListeners();
      try {
        probe.close();
      } catch {
        /* already closing */
      }
      resolve(occupied);
    };
    probe.once("error", () => done(true));
    try {
      probe.listen({ port, host: "0.0.0.0", exclusive: true }, () => done(false));
    } catch {
      done(true);
    }
  });
};

/** Validate and normalise a requested range. Throws rather than silently clamping. */
function normaliseRange(start: number, end: number): { lo: number; hi: number } {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new PortRangeInvalidError(start, end);
  }
  // An inverted range is a caller bug, not something to silently reinterpret.
  if (start > end) throw new PortRangeInvalidError(start, end);
  const lo = Math.max(1, start);
  const hi = Math.min(65535, end);
  if (lo > hi) throw new PortRangeInvalidError(start, end);
  return { lo, hi };
}

/** First free port in [start, end] not in `used`. Null when exhausted. */
export function findFreePort(
  used: Set<number> | number[],
  start = AUTO_PORT_START,
  end = AUTO_PORT_END,
): number | null {
  const taken = used instanceof Set ? used : new Set(used);
  // Preserve the historical clamp-and-scan behaviour of this helper: it is
  // called on paths that must not start throwing (the read-only ?free=1 probe),
  // and an inverted range simply yields null there.
  const lo = Math.max(1, Math.min(start, end));
  const hi = Math.min(65535, Math.max(start, end));
  for (let p = lo; p <= hi; p++) {
    if (!taken.has(p)) return p;
  }
  return null;
}

export interface AllocateOptions {
  start?: number;
  end?: number;
  /** Defaults to "nothing is occupied". The sync path is for tests. */
  isOccupied?: SyncPortOccupancyProbe;
}

export interface AllocateOptionsAsync {
  start?: number;
  end?: number;
  /** Defaults to the real OS probe. */
  isOccupied?: PortOccupancyProbe;
}

/**
 * Allocate one port, or throw a typed, actionable error.
 *
 * Checks both the database-reserved set and the occupancy probe, because those
 * are different sources of truth: a port can be free in the database and held
 * by an unrelated process on the host, and that is exactly the case that used
 * to surface as a generic tunnel failure at deploy time.
 */
export function allocatePort(
  used: Set<number> | number[],
  opts: AllocateOptions = {},
): number {
  const { start = AUTO_PORT_START, end = AUTO_PORT_END, isOccupied = () => false } = opts;
  const taken = used instanceof Set ? used : new Set(used);
  const { lo, hi } = normaliseRange(start, end);

  for (let p = lo; p <= hi; p++) {
    if (taken.has(p)) continue;
    if (!isOccupied(p)) return p;
  }
  throw new PortRangeExhaustedError(lo, hi);
}

/**
 * Allocate `count` distinct ports in one reservation pass.
 *
 * This is the fix for the check-then-create race: every port handed back is
 * recorded before the next candidate is considered, so two concurrent callers
 * in the same process can never receive the same number. Cross-process safety
 * additionally requires a re-check at bind time, which the deploy path already
 * does by failing loudly on a collision rather than double-binding.
 */
export function allocatePorts(
  count: number,
  opts: AllocateOptions = {},
): number[] {
  const { start = AUTO_PORT_START, end = AUTO_PORT_END, isOccupied = () => false } = opts;
  if (!Number.isInteger(count) || count < 0) {
    throw new PortRangeInvalidError(start, end);
  }
  const { lo, hi } = normaliseRange(start, end);

  // Uniqueness within a batch comes from the monotonically increasing `p`
  // itself: each candidate is considered exactly once. An earlier version kept
  // an explicit `reserved` set here and the comment claimed it was what
  // prevented duplicates; mutation testing showed removing it changed nothing,
  // because the loop counter already guarantees it. The set was dead code
  // carrying a misleading safety claim, so it is gone.
  const out: number[] = [];
  for (let p = lo; p <= hi && out.length < count; p++) {
    if (!isOccupied(p)) out.push(p);
  }
  if (out.length < count) throw new PortRangeExhaustedError(lo, hi);
  return out;
}

/** Async variants for callers that use the real OS probe. */
export async function allocatePortAsync(
  used: Set<number> | number[],
  opts: AllocateOptionsAsync = {},
): Promise<number> {
  const { start = AUTO_PORT_START, end = AUTO_PORT_END, isOccupied = isPortOccupied } = opts;
  const taken = used instanceof Set ? used : new Set(used);
  const { lo, hi } = normaliseRange(start, end);
  for (let p = lo; p <= hi; p++) {
    if (taken.has(p)) continue;
    if (!(await isOccupied(p))) return p;
  }
  throw new PortRangeExhaustedError(lo, hi);
}

export async function allocatePortsAsync(
  count: number,
  used: Set<number> | number[],
  opts: AllocateOptionsAsync = {},
): Promise<number[]> {
  const { start = AUTO_PORT_START, end = AUTO_PORT_END, isOccupied = isPortOccupied } = opts;
  const { lo, hi } = normaliseRange(start, end);
  const taken = used instanceof Set ? new Set(used) : new Set(used);
  const out: number[] = [];
  // `taken` is the caller's committed set; adding to it as we go is what keeps
  // a batch distinct, and it is live here because an await between iterations
  // means a caller could otherwise observe a half-built batch.
  for (let p = lo; p <= hi && out.length < count; p++) {
    if (taken.has(p)) continue;
    if (!(await isOccupied(p))) {
      taken.add(p);
      out.push(p);
    }
  }
  if (out.length < count) throw new PortRangeExhaustedError(lo, hi);
  return out;
}
