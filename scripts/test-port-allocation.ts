/**
 * Port allocation and conflict tests (TASK-24).
 *
 * Two distinct problems are covered here, and they are easy to conflate:
 *
 *  1. RANGE exhaustion -- every port in [start, end] is already taken in the
 *     database. The allocator must return a clear "exhausted" signal rather
 *     than null, which the caller cannot distinguish from "not found".
 *
 *  2. OS occupancy -- the database says port N is free, but some *other*
 *     process on the host already holds it. `findFreePort` only ever consulted
 *     the database, so it would hand out a port that fails at bind time. The
 *     panel then reports a generic tunnel failure instead of a port conflict,
 *     which is exactly the "specific conflict error" the task asks for.
 *
 * The OS check is injected. A real bind is used in the tests that matter, but
 * the allocator itself must be testable without binding 50 000 sockets.
 */
import { strict as assert } from "node:assert";
import net from "node:net";
import { pickPort } from "./lib/pick-port";

import {
  PortConflictError,
  PortRangeExhaustedError,
  allocatePort,
  allocatePorts,
  findFreePort,
  isPortOccupied,
  usedPortsOf,
} from "../apps/web/src/lib/ports.ts";

let pass = 0;
const failures: string[] = [];
const ok = (n: string): void => {
  pass += 1;
  console.log(`  ok   ${n}`);
};
const bad = (n: string, d: string): void => {
  failures.push(n);
  console.log(`  FAIL ${n}\n       ${d}`);
};

const settle = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * An occupancy probe backed by a Set, so tests can control it exactly.
 * Synchronous: the sync allocator takes a sync probe, and passing a promise
 * here made every port look free (a promise is truthy) and the allocator handed
 * out an occupied port -- which is exactly the bug the real fix prevents.
 */
const probeFor = (occupied: Set<number>) => (p: number): boolean => occupied.has(p);

/** A free TCP port, released immediately. */
const freePort = async (): Promise<number> => pickPort("127.0.0.1");

/** An occupancy probe that treats an already-committed port as occupied. */
const committedIn = (committed: number[], p: number): boolean => committed.includes(p);

async function main(): Promise<void> {
  try {
    // ---------------------------------------------------------------------
    // 0. usedPortsOf sanitises its input.
    // ---------------------------------------------------------------------
    {
      const used = usedPortsOf([80, null, undefined, 0, 70000, 1.5, "x" as never, 443], [8080]);
      if (used.has(80) && used.has(443) && used.has(8080)) ok("valid ports are collected");
      else bad("valid ports are collected", [...used].join(","));
      if (!used.has(0) && !used.has(70000) && used.size === 3) ok("out-of-range and non-integer ports are rejected");
      else bad("out-of-range ports are rejected", `size=${used.size} [${[...used].join(",")}]`);
    }

    // ---------------------------------------------------------------------
    // 1. Range boundaries: start, middle, end.
    // ---------------------------------------------------------------------
    {
      if (findFreePort(new Set(), 20000, 20100) === 20000) ok("the first free port is the start of the range");
      else bad("the first free port is the start of the range", String(findFreePort(new Set(), 20000, 20100)));

      const mid = new Set([20000, 20001, 20002]);
      if (findFreePort(mid, 20000, 20100) === 20003) ok("a hole in the middle of the range is filled");
      else bad("a hole in the middle is filled", String(findFreePort(mid, 20000, 20100)));

      const full = new Set(Array.from({ length: 101 }, (_, i) => 20000 + i));
      if (findFreePort(full, 20000, 20100) === null) ok("an exhausted range returns null from findFreePort");
      else bad("an exhausted range returns null", String(findFreePort(full, 20000, 20100)));
    }

    // ---------------------------------------------------------------------
    // 2. allocatePort distinguishes exhaustion from success, with a typed error.
    // ---------------------------------------------------------------------
    {
      const full = new Set(Array.from({ length: 11 }, (_, i) => 30000 + i));
      let err: unknown = null;
      try {
        allocatePort(full, { start: 30000, end: 30010, isOccupied: probeFor(new Set()) });
      } catch (e) {
        err = e;
      }
      if (err instanceof PortRangeExhaustedError) ok("an exhausted range throws PortRangeExhaustedError");
      else bad("an exhausted range throws PortRangeExhaustedError", String(err));
      if (err && /30000|30010/.test((err as Error).message)) ok("the exhaustion error names the range");
      else bad("the exhaustion error names the range", (err as Error)?.message);
    }

    // ---------------------------------------------------------------------
    // 3. A port held by ANOTHER PROCESS is skipped -- the real defect.
    // ---------------------------------------------------------------------
    {
      // The database says 20000 is free; the OS says otherwise.
      const isOccupied = probeFor(new Set([20000]));
      const got = allocatePort(new Set(), { start: 20000, end: 20010, isOccupied });
      if (got === 20001) ok("a port occupied by another process is skipped");
      else bad("a port occupied by another process is skipped", String(got));

      // And with everything occupied, it must be exhaustion, not null.
      const allBusy = probeFor(new Set(Array.from({ length: 11 }, (_, i) => 20000 + i)));
      let err: unknown = null;
      try {
        allocatePort(new Set(), { start: 20000, end: 20010, isOccupied: allBusy });
      } catch (e) {
        err = e;
      }
      if (err instanceof PortRangeExhaustedError) ok("a range busy at the OS level reports exhaustion");
      else bad("a range busy at the OS level reports exhaustion", String(err));
    }

    // ---------------------------------------------------------------------
    // 4. The OS probe is real: a bound socket must be detected.
    // ---------------------------------------------------------------------
    {
      const p = await freePort();
      // Bind all interfaces: the probe binds 0.0.0.0, and a listener on
      // 127.0.0.0 alone does NOT conflict with a 0.0.0.0 bind on Linux in all
      // cases -- comparing like with like is what makes this a real test.
      const server = net.createServer();
      await new Promise<void>((r) => server.listen({ port: p, host: "0.0.0.0", exclusive: true }, () => r()));
      let detected = false;
      try {
        detected = await isPortOccupied(p);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
      if (detected) ok("isPortOccupied detects a real bound socket");
      else bad("isPortOccupied detects a real bound socket", `port ${p} not detected`);

      const p2 = await freePort();
      let freeDetected = false;
      try {
        freeDetected = !(await isPortOccupied(p2));
      } catch {
        /* treat probe error as occupied */
      }
      if (freeDetected) ok("isPortOccupied reports a genuinely free port as free");
      else bad("isPortOccupied reports a free port as free", `port ${p2} reported busy`);
    }

    // ---------------------------------------------------------------------
    // 5. Concurrent allocation must not hand out the same port twice.
    // ---------------------------------------------------------------------
    {
      // No OS probe: this isolates the reservation logic itself.
      // Within a single batch, the reservation set is what guarantees no port
      // is handed out twice. Across batches, the caller is responsible for
      // feeding previously committed ports back in via `used` -- the allocator
      // is a pure function, not a global registry, so a test of two independent
      // calls that share no state would be testing nothing.
      const opts = { start: 21000, end: 21050, isOccupied: probeFor(new Set()) };
      const first = allocatePorts(4, opts);
      // The second batch sees the first batch's ports as taken, which is what
      // the API route does via collectUsedPorts().
      const second = allocatePorts(4, { ...opts, isOccupied: (p) => committedIn(first, p) });
      const got = [...first, ...second];
      const unique = new Set(got);
      if (got.length === 8 && unique.size === 8) ok(`two batches sharing state produced ${unique.size} distinct ports`);
      else bad("concurrent allocations are distinct", `got ${got.length}, unique ${unique.size}`);

      // The direct guarantee the reservation provides: within ONE batch, a
      // port is never handed out twice even though the occupancy probe reports
      // EVERY port as free. Without the reservation set the loop would return
      // the same first-free port on every iteration and the whole batch would
      // be that one number -- which is what mutation testing detected.
      let probeCalls = 0;
      const alwaysFree = (): boolean => {
        probeCalls += 1;
        return false;
      };
      const single = allocatePorts(5, { start: 21060, end: 21099, isOccupied: alwaysFree });
      if (probeCalls >= 5) ok(`the probe was consulted per candidate (${probeCalls} calls for 5 ports)`);
      else bad("the probe was consulted per candidate", `${probeCalls} calls`);
      if (new Set(single).size === 5) ok("a single 5-port batch contains no duplicates");
      else bad("a single batch contains no duplicates", `unique ${[...new Set(single)].join(",")}`);
      if (single[0] === 21060 && single[4] === 21064) ok("the batch walks the range in order");
      else bad("the batch walks the range in order", single.join(","));

      const inRange = got.every((p) => p >= 21000 && p <= 21050);
      if (inRange) ok("every allocated port is inside the configured range");
      else bad("every allocated port is inside the range", got.join(","));
    }

    // ---------------------------------------------------------------------
    // 6. Concurrent allocation that exhausts reports exhaustion, not a dup.
    // ---------------------------------------------------------------------
    {
      const opts = { start: 22000, end: 22002, isOccupied: probeFor(new Set()) };
      let err: unknown = null;
      let got: number[] = [];
      try {
        got = allocatePorts(5, opts);
      } catch (e) {
        err = e;
      }
      if (err instanceof PortRangeExhaustedError) ok("over-allocating a small range throws exhaustion");
      else bad("over-allocating a small range throws exhaustion", String(err));
      if (new Set(got).size === got.length) ok("no duplicates are returned before exhaustion");
      else bad("no duplicates are returned before exhaustion", got.join(","));
      // All-or-nothing is the correct contract. Handing back a partial batch
      // would let a caller create 2 of 5 rules and silently leave the rest
      // unallocated -- an "it mostly worked" outcome that is harder to reason
      // about than an explicit exhaustion error.
      if (got.length === 0) ok("a partial batch is discarded rather than returned (all-or-nothing)");
      else bad("a partial batch is discarded", `${got.length} ports returned on exhaustion`);

      // A request that exactly fits must still succeed.
      const exact = allocatePorts(3, { start: 22010, end: 22012, isOccupied: probeFor(new Set()) });
      if (exact.length === 3 && new Set(exact).size === 3) ok("a request that exactly fits the range succeeds");
      else bad("a request that exactly fits the range succeeds", exact.join(","));
    }

    // ---------------------------------------------------------------------
    // 7. Concurrent allocation under OS occupancy stays correct.
    // ---------------------------------------------------------------------
    {
      // Half the range is held by other processes.
      const busy = new Set([23000, 23001, 23002, 23003, 23004]);
      const opts = { start: 23000, end: 23010, isOccupied: probeFor(busy) };
      const got = allocatePorts(6, opts);
      const unique = new Set(got);
      if (unique.size === got.length) ok("allocation under OS occupancy has no duplicates");
      else bad("allocation under OS occupancy has no duplicates", got.join(","));
      if (got.every((p) => !busy.has(p))) ok("no allocated port collides with an OS-occupied one");
      else bad("no allocated port collides with an OS-occupied one", got.join(","));
    }

    // ---------------------------------------------------------------------
    // 8. PortConflictError is specific and carries the port + protocol.
    // ---------------------------------------------------------------------
    {
      const e = new PortConflictError(8080, "tcp", "existing-rule");
      if (e instanceof PortConflictError && e.port === 8080) ok("PortConflictError carries the port");
      else bad("PortConflictError carries the port", String(e));
      const msg = e.message;
      if (msg.includes("8080") && msg.includes("tcp")) ok("the conflict message names the port and protocol");
      else bad("the conflict message names port and protocol", msg);
      if (e.code === "PORT_CONFLICT") ok("the conflict error has a stable machine-readable code");
      else bad("the conflict error has a code", String(e.code));
    }

    // ---------------------------------------------------------------------
    // 9. A nonsense range is rejected rather than silently clamped away.
    // ---------------------------------------------------------------------
    {
      let err: unknown = null;
      try {
        allocatePort(new Set(), { start: 20000, end: 19999, isOccupied: probeFor(new Set()) });
      } catch (e) {
        err = e;
      }
      if (err !== null) ok("an inverted range is rejected");
      else bad("an inverted range is rejected", "it returned a port");

      // Out-of-absolute-bounds is clamped, not rejected: 70000 is not a valid
      // port, but a caller asking for a range that partially exceeds it should
      // still get a usable answer.
      const clamped = findFreePort(new Set(), 65400, 70000);
      if (clamped !== null && clamped <= 65535) ok(`a range exceeding 65535 is clamped (got ${clamped})`);
      else bad("a range exceeding 65535 is clamped", String(clamped));
    }

    console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    /* nothing to clean */
  }
}

void main();
assert.ok(true);
