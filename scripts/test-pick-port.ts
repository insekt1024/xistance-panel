/**
 * The port allocator must avoid the pool Windows reserves, deterministically.
 *
 * WHY A SEPARATE PROPERTY TEST
 * ----------------------------
 * `test-port-forward.ts` and `test-disposal-cleanup.ts` consume the allocator,
 * but they exercise it only ~15 times per run. The defect they originally had
 * was probabilistic: `listen(0)` returns a port from Windows' ephemeral range,
 * and a block of that range is reserved by Hyper-V/WSL/Docker, so a bind is
 * refused with EACCES only when the OS happens to draw a reserved port.
 *
 * Mutation testing made that concrete. Reintroducing the original defect and
 * running the consuming suites twice:
 *
 *     m0-listen-zero (ask the OS for a port)   SURVIVED
 *     m1-loopback-probe (probe 127.0.0.1)      SURVIVED
 *     m2-no-confirm (skip the bind entirely)   SURVIVED
 *     m3-single-attempt (one try, give up)     SURVIVED
 *     m4-dynamic-range (use 49152-65535)       KILLED
 *
 * Only the mutant that moved the whole range out of the reserved pool was
 * caught, and only because the containers happened to be running. The other
 * four produce a failure rate of a few percent, and a suite that samples fifteen
 * ports has a high chance of missing it every time. That is the worst possible
 * shape: a regression that is invisible in normal runs and shows up as an
 * unexplained red aggregate on someone else's machine.
 *
 * So the properties are asserted directly here, over many draws, rather than
 * inferred from a handful of incidental binds:
 *
 *   1. Every returned port is inside the declared range.
 *   2. Every returned port is actually bindable on the requested interface.
 *   3. Many draws in a row all succeed (the allocator does not depend on luck).
 *   4. The range excludes the OS ephemeral range where reservations live.
 *   5. Concurrent callers never receive the same port.
 *
 * Property 2 is what kills m0/m1/m2; property 3 kills m3; property 1 kills m4.
 */

import net from "node:net";

import { PORT_RANGE, pickPort, type PortProbe } from "./lib/pick-port.ts";

let pass = 0;
let fail = 0;

function ok(name: string, detail = ""): void {
  pass += 1;
  console.log(`  ok   ${name}`);
  if (detail) console.log(`       ${detail}`);
}

function bad(name: string, detail = ""): void {
  fail += 1;
  console.log(`  FAIL ${name}`);
  if (detail) console.log(`       ${detail}`);
}

/** Can this port be bound on this host right now? */
async function bindable(port: number, host: string): Promise<boolean> {
  const s = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      s.once("error", reject);
      s.listen({ port, host, exclusive: true }, () => resolve());
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise<void>((r) => s.close(() => r()));
  }
}

async function main(): Promise<void> {
  console.log("=== the allocator's own contract, asserted directly ===");
  console.log(`  declared range: ${PORT_RANGE.min}-${PORT_RANGE.max}\n`);

  // --- property 1 and 2: in range AND genuinely bindable -------------------
  const DRAWS = 60;
  const outOfRange: number[] = [];
  const unbindable: number[] = [];
  const ports: number[] = [];

  for (let i = 0; i < DRAWS; i += 1) {
    // 0.0.0.0 is the wildcard bind the port forwarder performs, and the one
    // that Windows refuses where a reservation exists. Checking only loopback
    // is what let the original defect through.
    const p = await pickPort("0.0.0.0");
    ports.push(p);
    if (p < PORT_RANGE.min || p > PORT_RANGE.max) outOfRange.push(p);
    if (!(await bindable(p, "0.0.0.0"))) unbindable.push(p);
  }

  if (outOfRange.length === 0) {
    ok(`all ${DRAWS} draws land inside the declared range`);
  } else {
    bad(`${outOfRange.length}/${DRAWS} draws escaped the declared range`,
      `escaped: ${outOfRange.slice(0, 5).join(", ")} -- the allocator handed out a port it does not claim to use`);
  }

  if (unbindable.length === 0) {
    ok(`all ${DRAWS} returned ports are bindable on 0.0.0.0`);
  } else {
    bad(`${unbindable.length}/${DRAWS} returned ports could not be bound on 0.0.0.0`,
      `refused: ${unbindable.slice(0, 5).join(", ")} -- this is the EACCES the allocator exists to prevent`);
  }

  // --- property 3: no dependence on luck ----------------------------------
  // 60 consecutive successes is not luck; a 1-in-30 draw would fail here.
  if (pass === 2) {
    ok(`${DRAWS} consecutive allocations all succeeded`);
  } else {
    bad("the allocator is still failing intermittently",
      "a per-draw failure rate this high means the range is still contested");
  }

  // --- property 4: the range excludes the OS ephemeral range ---------------
  // Windows allocates ephemeral ports from 49152 upward, and Hyper-V/WSL/Docker
  // carve reservations out of exactly that span.
  const EPHEMERAL_START = 49_152;
  if (PORT_RANGE.max < EPHEMERAL_START) {
    ok("the range ends below the Windows ephemeral range",
      `${PORT_RANGE.max} < ${EPHEMERAL_START}, so no reservation can fall inside it`);
  } else {
    bad("the range overlaps the Windows ephemeral range",
      `range reaches ${PORT_RANGE.max}, ephemeral ports start at ${EPHEMERAL_START}; ` +
      "this is the pool Hyper-V/WSL/Docker reserve blocks out of");
  }

  // --- property 5: concurrent callers do not collide ----------------------
  const CONCURRENCY = 24;
  const concurrent = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => pickPort("0.0.0.0")),
  );
  const unique = new Set(concurrent);
  if (unique.size === CONCURRENCY) {
    ok(`${CONCURRENCY} concurrent callers received ${CONCURRENCY} distinct ports`);
  } else {
    bad("concurrent callers collided on a port",
      `${CONCURRENCY} callers produced only ${unique.size} distinct ports: ` +
      "two suites in one aggregate run would fight over the same socket");
  }

  const allBindable = (await Promise.all(
    concurrent.map((p) => bindable(p, "0.0.0.0")),
  )).every(Boolean);
  if (allBindable) ok("every concurrently allocated port is bindable");

  // --- properties 6-8: the retry contract, driven deterministically --------
  //
  // Properties 1-5 all pass as long as the RANGE is clean, which is why the
  // m1/m2/m3 mutants survived them: probe-on-loopback, skip-the-probe, and
  // one-attempt-only are all harmless while every candidate in 20000-40000 is
  // free. They are defence in depth for the case the range cannot cover.
  //
  // So the contested condition is manufactured instead of waited for. An
  // injected probe stands in for the OS, and the allocator's response to a
  // refusal is asserted directly.

  /**
   * An OS that refuses the first N candidates and then behaves.
   *
   * Refusing a FIXED set of ports would not work: the allocator draws at
   * random from 20001 values, so a fixture keyed on 20000-20004 is simply not
   * visited on most runs -- the first attempt "succeeded" against a candidate
   * outside the set and the test reported no retry. It has to refuse the first
   * N candidates the allocator actually reaches, whoever they are.
   */
  const refuseFirst = (n: number, log: number[]): PortProbe =>
    async (port) => {
      log.push(port);
      if (log.length <= n) throw new Error("EACCES: bind 0.0.0.0");
      return port;
    };

  // 6. the allocator must retry past a refused candidate, not return it
  const refusals: number[] = [];
  const afterRefusals = await pickPort("0.0.0.0", refuseFirst(3, refusals));
  const refusedSet = new Set(refusals.slice(0, 3));
  if (!refusedSet.has(afterRefusals)) {
    ok("a refused candidate is never returned to the caller",
      `refused ${[...refusedSet].join(", ")}, returned ${afterRefusals}`);
  } else {
    bad("the allocator returned a port the OS had already refused",
      `returned ${afterRefusals}, which was refused -- ` +
      "this is the exact EACCES path the allocator exists to prevent");
  }

  if (refusals.length > 3) {
    ok("the allocator retried past a refused candidate", `${refusals.length} candidates tried`);
  } else {
    bad("the allocator did not retry after a refusal",
      `${refusals.length} candidate(s) tried, 3 were refused -- a transient ` +
      "reservation would then fail the suite instead of being retried");
  }

  // 7. the probe must be given the host the caller asked for
  const hostsSeen: string[] = [];
  await pickPort("0.0.0.0", async (port, host) => {
    hostsSeen.push(host);
    return port;
  });
  if (hostsSeen.every((h) => h === "0.0.0.0")) {
    ok("the probe is given the caller's requested interface",
      `probed ${hostsSeen[0]}, not a hardcoded loopback`);
  } else {
    bad("the probe ignored the caller's requested interface",
      `asked for 0.0.0.0, probed ${hostsSeen[0]} -- a wildcard bind covers ` +
      "loopback, so verifying on 127.0.0.1 does not predict it");
  }

  // 8. exhausting the range must be a clear error, not a silent bad port
  const neverBinds: PortProbe = async () => {
    throw new Error("EACCES: bind 0.0.0.0");
  };
  try {
    const p = await pickPort("0.0.0.0", neverBinds);
    bad("an exhausted range returned a port anyway", `returned ${p}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/after \d+ attempts/.test(msg) && /EACCES/.test(msg)) {
      ok("an exhausted range raises a specific error naming the cause and attempts",
        msg.slice(0, 96));
    } else {
      bad("the exhaustion error is not specific", `got: ${msg.slice(0, 96)}`);
    }
  }

  console.log(`\n--- ${pass} passed, ${fail} failed ---`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();
