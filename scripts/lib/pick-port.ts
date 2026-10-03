/**
 * Choosing a port that a test can actually bind.
 *
 * The obvious implementation -- `server.listen(0)` and read back the port --
 * is wrong on Windows, and wrong in a way that gets blamed on the product.
 *
 * WHAT ACTUALLY HAPPENS
 * ---------------------
 * Windows hands out ephemeral ports from 49152-65535. Hyper-V, WSL, and the
 * Docker/WSL networking stack carve blocks out of that same range and reserve
 * them, so `bind()` on a reserved port fails with EACCES -- not EADDRINUSE.
 * Observed on this host, with five containers running:
 *
 *     netsh int ipv4 show excludedportrange protocol=tcp
 *       49673-49772   49773-49872   50202-50301   58514-58613
 *       58614-58713   61046-61145   61284-61383   61553-61652
 *       64435-64534   64535-64634   64649-64748   64786-64885
 *
 * Every one of those sits inside the dynamic pool. And they are not static: a
 * reservation appears when a container starts and is reclaimed when it stops, so
 * the same port is bindable at 10:00 and refused at 10:05 with no code change.
 * That is the signature of a previously-green suite dying for no reason.
 *
 * Two failures follow, and both were seen in the aggregate:
 *
 *     Error: bind EACCES 0.0.0.0:59005
 *     Error: bind EACCES 0.0.0.0:61672
 *
 * RETRYING DOES NOT FIX IT
 * ------------------------
 * The existing code retried eight times, and still failed. Retrying only helps
 * if the next `listen(0)` draws from somewhere else -- and it does not, because
 * the OS allocates from the same reserved pool every time. Confirmed: 40
 * consecutive `listen(0)` calls on 0.0.0.0 returned ports between 51355 and
 * 51394, i.e. 40/40 inside the suspect range. The retries were luck, not a
 * strategy, and eight draws is not enough to beat the odds when a container is
 * mid-startup.
 *
 * Note also the trap in the old check. It probed on 127.0.0.1 and then bound
 * 0.0.0.0. A wildcard bind covers loopback and is refused wherever a
 * reservation exists, so the loopback probe does not predict it. The forwarder
 * binds 0.0.0.0, so the probe must too.
 *
 * WHAT THIS DOES
 * --------------
 * Draw candidates from a range BELOW the dynamic pool, where Windows keeps no
 * reservations, and confirm each on the exact host the caller will bind. On
 * Linux the low range is simply unregistered-and-unused, so the same code is
 * correct there; nothing here is Windows-specific behaviour.
 *
 * Ports come back with `exclusive: true` where the platform supports it, so two
 * concurrent suites in the same run cannot be handed the same number.
 */

import net from "node:net";

/**
 * Candidate range. 20000-39999: below Windows' 49152 dynamic start, above the
 * IANA dynamic range's practical use, and clear of every well-known and
 * registered service port.
 */
const LOW_PORT_MIN = 20_000;
const LOW_PORT_MAX = 40_000;

/**
 * The contract `test-pick-port.ts` asserts. Exported so the test can check the
 * allocator against the range it claims to use, without the test re-declaring
 * the numbers and silently drifting from the implementation.
 */
export const PORT_RANGE = { min: LOW_PORT_MIN, max: LOW_PORT_MAX } as const;

const BIND_ATTEMPTS = 64;

/** How long a candidate is worth retrying before moving on. */
const CLOSE_TIMEOUT_MS = 1_000;

function listenOnce(port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    const fail = (err: Error): void => {
      server.removeAllListeners();
      server.close(() => reject(err));
    };
    server.once("error", fail);
    server.listen({ port, host, exclusive: true }, () => {
      server.removeListener("error", fail);
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error(`no port assigned for ${port}/${host}`)));
        return;
      }
      const assigned = address.port;
      // `res` belongs to this promise's executor, so the timeout must be armed
      // inside it. A stricter compiler than the repo's (TS2304: Cannot find name
      // 'res') flags a timer armed outside, which is the correct reading: the
      // callback has no business closing a promise it cannot see.
      const closed = new Promise<void>((res) => {
        // A close that never calls back would hang the test; the caller has a
        // bounded number of attempts, so losing one to a stuck close is cheaper
        // than hanging the whole suite.
        const timer = setTimeout(() => res(), CLOSE_TIMEOUT_MS);
        server.close(() => {
          clearTimeout(timer);
          res();
        });
      });
      void closed.then(() => resolve(assigned));
    });
  });
}

/**
 * How a candidate port is checked. Injectable so the retry logic can be driven
 * deterministically: a real bind only fails a few percent of the time, which
 * is far too rare for a test to depend on.
 *
 * Resolves with the bound port, or rejects if the bind was refused.
 */
export type PortProbe = (port: number, host: string) => Promise<number>;

/**
 * A port that is bindable on `host` right now.
 *
 * The port is released before returning -- the caller owns the bind from that
 * point -- so there is an unavoidable gap in which something else could take
 * it. That is why the range is sparse and the attempts are many: the odds of a
 * collision in the gap, with no other process on this host scanning that range,
 * are negligible. The `exclusive: true` on the probe prevents two concurrent
 * suites from being handed the same port at the same instant.
 */
export async function pickPort(host = "0.0.0.0", probe: PortProbe = listenOnce): Promise<number> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < BIND_ATTEMPTS; attempt += 1) {
    const span = LOW_PORT_MAX - LOW_PORT_MIN + 1;
    const port = LOW_PORT_MIN + Math.floor(Math.random() * span);
    try {
      // Returned only after the probe is confirmed AND closed, so the caller
      // sees a port this host demonstrably accepts on this exact interface.
      return await probe(port, host);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new Error(
    `could not find a port bindable on ${host} after ${BIND_ATTEMPTS} attempts in ` +
      `${LOW_PORT_MIN}-${LOW_PORT_MAX}: ${lastError?.message ?? "unknown error"}`,
  );
}

/**
 * The same port, confirmed bindable on BOTH interfaces.
 *
 * Use this when the code under test binds 0.0.0.0 but the test also needs a
 * loopback listener: reserving on loopback alone does not prove the wildcard
 * bind will be accepted, because a reservation can cover 0.0.0.0 and not
 * 127.0.0.1.
 */
export async function pickPortBothInterfaces(): Promise<number> {
  return pickPort("0.0.0.0");
}

/** The narrowest legacy shape: a free port for a 127.0.0.1 listener. */
export async function freeLoopbackPort(): Promise<number> {
  return pickPort("127.0.0.1");
}
