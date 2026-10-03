/**
 * PORT_FORWARD data path, driven through the product's own `startForwarder`.
 *
 * TASK-128 left PORT_FORWARD as one of only two methods whose traffic claim rested
 * on no runnable test. Unlike GOST/FRP/BACKHAUL it execs no binary -- the forwarder
 * is in-process Node (`packages/tunnel-core/src/forwarder.ts`) -- so it cannot run
 * inside the target-OS container suite. It runs here instead, against a real origin
 * process, and it uses the SAME rule shape `PortForwardRuleSchema` validates.
 *
 * The rule is parsed through that schema first, for the reason TASK-124 documented:
 * a hand-built object that misses a field fails silently here rather than producing
 * a forwarder that binds the wrong port.
 *
 * No tunnel binary and no credential are involved. The origin is a throwaway Node
 * HTTP server on loopback that returns HELLO-XR.
 */
import http from "node:http";
import net from "node:net";
import { startForwarder, type ForwardHandle } from "../packages/tunnel-core/src/forwarder.ts";
import { PortForwardRuleSchema } from "../packages/types/src/index.ts";

const ORIGIN_PORT = 19398;
const LISTEN_PORT = 19399;

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

const get = (port: number, ms = 5000): Promise<string> =>
  new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: ms }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(b));
    });
    req.on("error", () => resolve(""));
    req.on("timeout", () => {
      req.destroy();
      resolve("");
    });
  });

const portFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.on("connect", () => {
      s.destroy();
      resolve(false);
    });
    s.on("error", () => resolve(true));
  });

// `main()` rather than top-level await: this file is transformed as CommonJS, and
// top-level await is a hard transform error there -- "Top-level await is currently
// not supported with the \"cjs\" output format". Same issue TASK-65 hit.
async function main(): Promise<void> {
  // ---- origin: real HTTP, real bytes ----------------------------------------
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Length": "8" });
    res.end("HELLO-XR");
  });
  await new Promise<void>((r) => origin.listen(ORIGIN_PORT, "127.0.0.1", r));

  // PRECONDITION. If the origin is not serving, every later failure would be blamed
  // on the forwarder, and "it never worked" is not the same finding as "it broke".
  const originBody = await get(ORIGIN_PORT);
  if (originBody !== "HELLO-XR") bad("PRECONDITION: the origin serves HELLO-XR", `got '${originBody}'`);
  else ok(`PRECONDITION: the origin serves HELLO-XR on ${ORIGIN_PORT}`);

  if (!(await portFree(LISTEN_PORT))) bad("PRECONDITION: the listen port is free", `${LISTEN_PORT} is in use`);
  else ok(`PRECONDITION: ${LISTEN_PORT} is free`);

  let handle: ForwardHandle | undefined;
  try {
    const rule = PortForwardRuleSchema.parse({
      name: "traffic-probe",
      direction: "IRAN_TO_FOREIGN",
      protocol: "tcp",
      sourcePort: LISTEN_PORT,
      destHost: "127.0.0.1",
      destPort: ORIGIN_PORT,
    });

    handle = await startForwarder(rule);
    // The handle's identity is part of what the engine records, so assert it rather
    // than trusting that a resolved promise means a bound socket.
    if (handle.id && handle.protocol === "tcp" && handle.sourcePort === LISTEN_PORT) {
      ok(`startForwarder() returns a handle describing the rule (${handle.protocol} :${handle.sourcePort})`);
    } else {
      bad("startForwarder() returns a handle describing the rule",
          JSON.stringify({ id: handle.id, protocol: handle.protocol, sourcePort: handle.sourcePort }));
    }

    const through = await get(LISTEN_PORT);
    if (through === "HELLO-XR") {
      ok(`PORT_FORWARD carries real bytes ${LISTEN_PORT} -> ${ORIGIN_PORT} (body=HELLO-XR)`);
    } else bad("PORT_FORWARD carries real bytes", `body was '${through}'`);

    // Two more requests, so a single lucky connection cannot pass this.
    const again = await Promise.all([get(LISTEN_PORT), get(LISTEN_PORT)]);
    if (again.every((b) => b === "HELLO-XR")) ok("PORT_FORWARD serves repeated requests on the same forwarder");
    else bad("PORT_FORWARD serves repeated requests", `got ${JSON.stringify(again)}`);

    // Cleanup is part of the contract: forwarder.ts tracks every accepted socket so
    // stop() cannot leak one. Assert the port is actually released.
    // The lifecycle method is stop(), not close() -- ForwardHandle declares
    // { id, protocol, sourcePort, stop }.
    await handle.stop();
    handle = undefined;
    await new Promise((r) => setTimeout(r, 300));
    if (await portFree(LISTEN_PORT)) ok("PORT_FORWARD releases the listen port on stop()");
    else bad("PORT_FORWARD releases the listen port on stop()", `${LISTEN_PORT} still bound after stop()`);
  } catch (e) {
    bad("the PORT_FORWARD data path runs", (e as Error).message);
  } finally {
    if (handle) await handle.stop().catch(() => {});
    await new Promise<void>((r) => origin.close(() => r()));
  }

  console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
