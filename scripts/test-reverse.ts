/**
 * REVERSE method coverage (TASK-32).
 *
 * REVERSE is one-click `ssh -R`: expose `listenPort` on the Foreign side,
 * carry traffic back to `forwardHost:forwardPort` on the Iran side.
 *
 * The gap this suite exists for: **a live `ssh -R` process is not proof that
 * the port is externally reachable.** When the remote sshd has
 * `GatewayPorts no` (the Debian/Ubuntu default), ssh silently binds the remote
 * listener to loopback instead of failing. The tunnel is alive, the port is
 * listening, and nothing can reach it from the internet -- yet every existing
 * signal says `running`.
 *
 * The distinction the acceptance criteria demand:
 *   process alive + remote bind reachable  -> running
 *   process alive + remote bind loopback    -> degraded, with an explanation
 */

import assert from "node:assert/strict";
import { reverseToSshConfig } from "../packages/tunnel-core/src/config/reverse.ts";
import {
  ReverseConfigSchema,
  TunnelConfigSchema,
  TunnelMethod,
  type ReverseConfig,
} from "../packages/types/src/index.ts";

let pass = 0;
const failures: string[] = [];
const ok = (name: string) => {
  pass += 1;
  console.log(`  ok   ${name}`);
};
const bad = (name: string, detail: string) => {
  failures.push(name);
  console.log(`  FAIL ${name}\n       ${detail}`);
};

const RAW: ReverseConfig = {
  protocol: "tcp",
  listenPort: 8080,
  forwardHost: "127.0.0.1",
  forwardPort: 3000,
  host: "203.0.113.10",
  port: 22,
  username: "deploy",
  auth: "key",
  remoteBindAddr: "0.0.0.0",
  extraArgs: [],
  useAutossh: false,
  autosshMonitorPort: 0,
  autosshPoll: 60,
};
const mk = (patch: Partial<ReverseConfig> = {}): ReverseConfig =>
  DirectParse({ ...RAW, ...patch });

// Parse through the schema, which is where defaults are applied.
function DirectParse(raw: unknown): ReverseConfig {
  return ReverseConfigSchema.parse(raw) as ReverseConfig;
}

async function main() {
  console.log("\n--- config mapping ---");
  // A parse that throws must be reported, not crash the run: several checks
  // deliberately feed the schema values it should refuse, and one mutation
  // reintroduces a throw there. An uncaught throw would still exit 1, but it
  // would hide which assertion broke.
  process.on("uncaughtException", (e) => {
    bad("the suite ran to completion", `uncaught: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
    process.exit(1);
  });

  // ---- 1. remote listen port is exposed, direction is correct ---------------
  {
    const ssh = reverseToSshConfig(mk(), "198.51.100.7");
    if (ssh.mode === "remote") ok("the mapping produces an ssh remote-forward");
    else bad("the mapping produces an ssh remote-forward", ssh.mode);
    if (ssh.remotePort === 8080) ok("the remote listen port is exposed as ssh remotePort");
    else bad("the remote listen port is exposed", String(ssh.remotePort));
    if (ssh.remoteHost === "127.0.0.1") ok("the remote side points at the configured forward host");
    else bad("the remote side points at the forward host", ssh.remoteHost);
    if (ssh.localPort === 3000) ok("the local service port is the ssh localPort");
    else bad("the local service port is the ssh localPort", String(ssh.localPort));
  }

  // The single most damaging possible bug: a reversed -R. That would expose
  // 3000 and forward to 8080 -- both plausible-looking and entirely wrong.
  {
    const ssh = reverseToSshConfig(mk(), "198.51.100.7");
    const reversed = ssh.remotePort === ssh.localPort && ssh.remoteHost === ssh.localHost;
    if (!reversed) ok("the -R direction is not reversed");
    else bad("the -R direction is not reversed", `remote=${ssh.remotePort} local=${ssh.localPort}`);
  }

  // ---- 2. empty host falls back to the Foreign node -----------------------
  {
    const ssh = reverseToSshConfig(mk({ host: "" }), "198.51.100.7");
    if (ssh.host === "198.51.100.7") ok("an empty host falls back to the Foreign node address");
    else bad("an empty host falls back to the Foreign node address", ssh.host);
  }
  {
    // Raw object again: the schema refuses whitespace, so the fallback branch
    // for it is only reachable from a caller that bypassed validation.
    const blank = { ...RAW, host: "   " } as ReverseConfig;
    const ssh = reverseToSshConfig(blank, "198.51.100.7");
    if (ssh.host === "198.51.100.7") ok("a whitespace-only host also falls back");
    else bad("a whitespace-only host also falls back", JSON.stringify(ssh.host));
  }
  {
    const ssh = reverseToSshConfig(mk({ host: "" }), "");
    if (ssh.host === "") ok("with no host and no node the mapping yields an empty host, not undefined");
    else bad("with no host and no node the host is empty", String(ssh.host));
  }
  {
    // Deliberately NOT via mk(): the schema now refuses a padded host, which is
    // correct. The trim belongs to reverseToSshConfig, so it is tested on a raw
    // object -- the layer that owns the behaviour.
    const padded = { ...RAW, host: "  203.0.113.9  " } as ReverseConfig;
    const ssh = reverseToSshConfig(padded, "198.51.100.7");
    if (ssh.host === "203.0.113.9") ok("a padded host is trimmed rather than dialled with spaces");
    else bad("a padded host is trimmed", JSON.stringify(ssh.host));
  }
  {
    const r = ReverseConfigSchema.safeParse({ ...RAW, host: "  203.0.113.9  " });
    if (!r.success) ok("the schema refuses a padded host outright");
    else bad("the schema refuses a padded host", "accepted");
  }

  // ---- 3. remote bind address ---------------------------------------------
  {
    const ssh = reverseToSshConfig(mk({ remoteBindAddr: "0.0.0.0" }), "198.51.100.7");
    if (ssh.remoteBindAddr === "0.0.0.0") ok("the remote bind address is carried through to ssh");
    else bad("the remote bind address is carried through", ssh.remoteBindAddr);
  }
  {
    const ssh = reverseToSshConfig(mk({ remoteBindAddr: "127.0.0.1" }), "198.51.100.7");
    if (ssh.remoteBindAddr === "127.0.0.1") ok("a loopback remote bind is preserved, not widened to 0.0.0.0");
    else bad("a loopback remote bind is preserved", ssh.remoteBindAddr);
  }

  // ---- 4. TCP only ---------------------------------------------------------
  {
    const r = ReverseConfigSchema.safeParse({ ...RAW, protocol: "udp" });
    if (!r.success) ok("REVERSE refuses UDP (OpenSSH -R cannot forward UDP)");
    else bad("REVERSE refuses UDP", "udp parsed successfully");
  }
  {
    const r = ReverseConfigSchema.safeParse({ ...RAW, protocol: "sctp" });
    if (!r.success) ok("REVERSE refuses a protocol other than tcp");
    else bad("REVERSE refuses other protocols", "sctp parsed successfully");
  }

  // ---- 5. port ranges ------------------------------------------------------
  {
    const bad1 = ReverseConfigSchema.safeParse({ ...RAW, listenPort: 0 });
    const bad2 = ReverseConfigSchema.safeParse({ ...RAW, listenPort: 70000 });
    const bad3 = ReverseConfigSchema.safeParse({ ...RAW, forwardPort: 0 });
    const bad4 = ReverseConfigSchema.safeParse({ ...RAW, forwardPort: 70000 });
    if (!bad1.success && !bad2.success) ok("an out-of-range remote listen port is refused");
    else bad("an out-of-range remote listen port is refused", "accepted");
    if (!bad3.success && !bad4.success) ok("an out-of-range local service port is refused");
    else bad("an out-of-range local service port is refused", "accepted");
    const frac = ReverseConfigSchema.safeParse({ ...RAW, listenPort: 80.5 });
    if (!frac.success) ok("a fractional port is refused");
    else bad("a fractional port is refused", "accepted");
  }

  // ---- 6. the ssh destination must be safe ---------------------------------
  // The mapping feeds the same builder that TASK-29 hardened, but REVERSE's
  // schema does not inherit those checks, so a hostile username could reach
  // the destination token through this path.
  {
    const hostile: Array<[string, Partial<ReverseConfig>]> = [
      ["leading-dash username", { username: "-oProxyCommand=touch /tmp/pwn" }],
      ["username with a space", { username: "root root" }],
      ["host with a space", { host: "203.0.113.1 203.0.113.2" }],
      ["leading-dash host", { host: "-oProxyCommand=x" }],
      ["username with a newline", { username: "root\nroot" }],
    ];
    let accepted = 0;
    for (const [label, patch] of hostile) {
      const r = ReverseConfigSchema.safeParse({ ...RAW, ...patch });
      if (r.success) {
        accepted += 1;
        bad(`REVERSE refuses a ${label}`, "the schema accepted it");
      }
    }
    if (accepted === 0) ok(`REVERSE refuses all ${hostile.length} hostile SSH destination values`);
  }

  // ---- 7. remoteBindAddr must be a bare address ---------------------------
  {
    const hostile: Array<[string, string]> = [
      ["a scheme", "0.0.0.0/x"],
      ["a slash", "0.0.0.0/1"],
      ["a leading dash", "-x"],
      ["an embedded space", "0.0.0.0 1"],
    ];
    let accepted = 0;
    for (const [label, v] of hostile) {
      const r = ReverseConfigSchema.safeParse({ ...RAW, remoteBindAddr: v });
      if (r.success) {
        accepted += 1;
        bad(`REVERSE refuses a remoteBindAddr with ${label}`, `accepted ${JSON.stringify(v)}`);
      }
    }
    if (accepted === 0) ok(`REVERSE refuses all ${hostile.length} malformed remoteBindAddr values`);
  }
  {
    // forwardHost is spliced into the -R argument as a destination, so it
    // carries the same risk.
    const hostile: Array<[string, string]> = [
      ["a slash", "127.0.0.1/9"],
      ["a leading dash", "-x"],
      ["a space", "127.0.0.1 9"],
    ];
    let accepted = 0;
    for (const [label, v] of hostile) {
      const r = ReverseConfigSchema.safeParse({ ...RAW, forwardHost: v });
      if (r.success) {
        accepted += 1;
        bad(`REVERSE refuses a forwardHost with ${label}`, `accepted ${JSON.stringify(v)}`);
      }
    }
    if (accepted === 0) ok(`REVERSE refuses all ${hostile.length} malformed forwardHost values`);
  }

  // ---- 8. GatewayPorts: the core of this task ------------------------------
  // A live ssh -R with GatewayPorts=no binds the remote listener to loopback.
  // The process is healthy, the port is listening, and the tunnel is
  // unreachable from anywhere but the Foreign host itself. "running" would be
  // a lie an operator acts on.
  {
    const probe = await import("../packages/tunnel-core/src/reachability.ts").then(
      (m) => m.probeReverseReachability,
    );
    if (typeof probe !== "function") {
      bad("a reachability probe exists for REVERSE", `probe is ${typeof probe}`);
    } else {
      // The probe is asked what the remote side is bound to. Loopback is the
      // GatewayPorts=no outcome.
      const loopback = await probe({ boundAddress: "127.0.0.1", requestedAddress: "0.0.0.0", listening: true });
      if (loopback.reachable === false) ok("a remote listener bound to loopback is not reported reachable");
      else bad("a remote listener bound to loopback is not reported reachable", JSON.stringify(loopback));
      if (loopback.reason && /gatewayports/i.test(loopback.reason)) {
        ok("the loopback outcome names GatewayPorts, the actual cause");
      } else {
        bad("the loopback outcome names GatewayPorts", String(loopback.reason));
      }
      if (loopback.recovery && loopback.recovery.length > 0) ok("the loopback outcome offers a remedy");
      else bad("the loopback outcome offers a remedy", "no recovery hint");

      const publicBind = await probe({ boundAddress: "0.0.0.0", requestedAddress: "0.0.0.0", listening: true });
      if (publicBind.reachable === true) ok("a remote listener bound to 0.0.0.0 is reported reachable");
      else bad("a remote listener bound to 0.0.0.0 is reported reachable", JSON.stringify(publicBind));

      // Requesting loopback and getting it is a deliberate choice, not a
      // misconfiguration -- it must not be flagged.
      const asked = await probe({ boundAddress: "127.0.0.1", requestedAddress: "127.0.0.1", listening: true });
      if (asked.reachable === true) ok("a deliberate loopback bind is not flagged as a fault");
      else bad("a deliberate loopback bind is not flagged as a fault", JSON.stringify(asked));

      // Not listening at all is a different failure and must not be reported
      // as "running".
      const down = await probe({ boundAddress: "0.0.0.0", requestedAddress: "0.0.0.0", listening: false });
      if (down.reachable === false) ok("a remote listener that is not listening is not reported reachable");
      else bad("a remote listener that is not listening is not reported reachable", JSON.stringify(down));
    }
  }

  // ---- 9. status reflects reachability, not just liveness ------------------
  {
    const mod = await import("../packages/tunnel-core/src/reachability.ts");
    if (typeof mod.reverseStatus !== "function") {
      bad("reachability maps to a tunnel status", `reverseStatus is ${typeof mod.reverseStatus}`);
    } else {
      const cases: Array<[string, unknown, string]> = [
        ["reachable", { reachable: true, listening: true, boundAddress: "0.0.0.0" }, "running"],
        ["loopback-bound", { reachable: false, listening: true, boundAddress: "127.0.0.1" }, "degraded"],
        ["not listening", { reachable: false, listening: false, boundAddress: "0.0.0.0" }, "degraded"],
      ];
      let wrong = 0;
      for (const [label, probe, want] of cases) {
        const got = mod.reverseStatus(probe as never, "running");
        if (got !== want) {
          wrong += 1;
          bad(`${label} maps to ${want}`, String(got));
        }
      }
      if (wrong === 0) ok("liveness alone never yields `running` when the remote bind is loopback");
    }
  }

  // ---- 10. the union path --------------------------------------------------
  {
    const viaUnion = (patch: Record<string, unknown>): string => {
      const r = TunnelConfigSchema.safeParse({ method: TunnelMethod.REVERSE, reverse: { ...RAW, ...patch } });
      return r.success ? "<no error>" : r.error.issues.map((i) => i.message).join("; ");
    };
    if (viaUnion({}) === "<no error>") ok("a well-formed REVERSE tunnel validates through TunnelConfigSchema");
    else bad("a well-formed REVERSE tunnel validates", viaUnion({}));

    if (/tcp/i.test(viaUnion({ protocol: "udp" }))) ok("UDP is rejected through the union as well");
    else bad("UDP is rejected through the union", viaUnion({ protocol: "udp" }));
  }

  // ---- 11. engine wiring: a live REVERSE tunnel must not report running ----
  // A pure-function test proves the classifier works. This proves the ENGINE
  // calls it -- the failure mode where a correct module is never wired in is
  // exactly what happened to selectForwardStatus in TASK-30, so it is tested
  // explicitly rather than assumed.
  {
    const fsmod = await import("node:fs");
    const osmod = await import("node:os");
    const pathmod = await import("node:path");
    const { TunnelEngine } = await import("../packages/tunnel-core/src/engine.ts");

    const dataDir = fsmod.mkdtempSync(pathmod.join(osmod.tmpdir(), "xt-rev-"));
    const binDir = pathmod.join(dataDir, "bin");
    fsmod.mkdirSync(binDir, { recursive: true });
    // A real file so the REVERSE preflight (which skips binary checks but still
    // resolves a node context) has something to work with.
    for (const n of ["ssh", "autossh"]) {
      const f = pathmod.join(binDir, n);
      fsmod.writeFileSync(f, "#!/bin/sh\nexit 0\n");
      try { fsmod.chmodSync(f, 0o755); } catch { /* best effort on Windows */ }
    }

    class Handle {
      running = true;
      starts = 0;
      stops = 0;
      constructor(readonly spec: { unitName: string }) {}
      async isRunning() { return this.running; }
      async start() { this.running = true; this.starts += 1; }
      async stop() { this.running = false; this.stops += 1; }
    }

    /**
     * Runner whose `ss` output is whatever the test wants to simulate.
     *
     * `which` must answer, because sshPlanEntry resolves ssh/autossh through
     * systemBin before planning -- an empty answer there fails the deploy with
     * "Required system tool ssh is missing", which is a fixture problem, not the
     * behaviour under test.
     */
    const makeRunner = (ssStdout: string) => ({
      kind: "local" as const,
      async run(cmd: string[]) {
        const joined = cmd.join(" ");
        if (joined.includes("ss -ltnH")) return { stdout: ssStdout, stderr: "", exitCode: 0 };
        // ssStdout is the post-awk token, i.e. "127.0.0.1:8080".
        if (joined.includes("which")) {
          return { stdout: joined.includes("autossh") ? "/usr/bin/autossh\n" : "/usr/bin/ssh\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async writeFile() { return undefined; }
    });

    const spec = {
      id: "rev-1",
      name: "reverse",
      method: TunnelMethod.REVERSE,
      config: { method: TunnelMethod.REVERSE, reverse: RAW },
      clientNode: { id: "iran", host: "127.0.0.1", isLocal: true, username: "root", keyPath: undefined, authMethod: "key" as const },
      serverNode: { id: "foreign", host: "127.0.0.1", isLocal: true, username: "root", keyPath: undefined, authMethod: "key" as const },
    } as never;

    // Case 1: the remote port is bound to loopback (GatewayPorts no).
    {
      const handles: Handle[] = [];
      const engine = new TunnelEngine({
        dataDir,
        localBinDir: binDir,
        forceNodeFallback: true,
        forwarderRunner: { prefix: ["node"], script: "forwarder.mjs" },
        createProcessHandle: async (s) => {
          const h = new Handle(s as { unitName: string });
          handles.push(h);
          return h as never;
        },
      } as never);
      // Force the probe to see a loopback listener.
      (engine as never as { ctxFor: (n: unknown) => { runner: unknown } }).ctxFor = () => ({
        runner: makeRunner("127.0.0.1:8080"),
        binDir,
        cfgDir: dataDir,
        dataDir,
        name: "foreign",
      });
      await engine.deploy(spec);
      const st = await engine.status("rev-1");
      if (st === "degraded") ok("a live REVERSE tunnel bound to loopback reports degraded, not running");
      else bad("a live REVERSE tunnel bound to loopback reports degraded", String(st));
      if (handles.length === 1 && handles[0].running) ok("the ssh process really was alive, so liveness is not what changed");
      else bad("the ssh process really was alive", `${handles.length} handles`);
      // And the diagnostic must explain the cause, not just say "degraded".
      const d = (engine as never as { diagnostics: { latest: (id: string) => { summary: string } | undefined } }).diagnostics.latest("rev-1");
      if (d && /gatewayports/i.test(d.summary)) ok("the diagnostic names GatewayPorts as the cause");
      else bad("the diagnostic names GatewayPorts", JSON.stringify(d?.summary));
    }

    // Case 2: the same tunnel, but the remote port is on 0.0.0.0.
    {
      const handles: Handle[] = [];
      const engine = new TunnelEngine({
        dataDir,
        localBinDir: binDir,
        forceNodeFallback: true,
        forwarderRunner: { prefix: ["node"], script: "forwarder.mjs" },
        createProcessHandle: async (s) => {
          const h = new Handle(s as { unitName: string });
          handles.push(h);
          return h as never;
        },
      } as never);
      (engine as never as { ctxFor: (n: unknown) => { runner: unknown } }).ctxFor = () => ({
        runner: makeRunner("0.0.0.0:8080"),
        binDir,
        cfgDir: dataDir,
        dataDir,
        name: "foreign",
      });
      await engine.deploy(spec);
      const st = await engine.status("rev-1");
      if (st === "running") ok("a REVERSE tunnel bound to 0.0.0.0 reports running");
      else bad("a REVERSE tunnel bound to 0.0.0.0 reports running", String(st));
    }

    // Case 3: the remote port is not listening at all.
    {
      const handles: Handle[] = [];
      const engine = new TunnelEngine({
        dataDir,
        localBinDir: binDir,
        forceNodeFallback: true,
        forwarderRunner: { prefix: ["node"], script: "forwarder.mjs" },
        createProcessHandle: async (s) => {
          const h = new Handle(s as { unitName: string });
          handles.push(h);
          return h as never;
        },
      } as never);
      (engine as never as { ctxFor: (n: unknown) => { runner: unknown } }).ctxFor = () => ({
        runner: makeRunner(""),
        binDir,
        cfgDir: dataDir,
        dataDir,
        name: "foreign",
      });
      await engine.deploy(spec);
      const st = await engine.status("rev-1");
      if (st === "degraded") ok("a REVERSE tunnel with no remote listener reports degraded");
      else bad("a REVERSE tunnel with no remote listener reports degraded", String(st));
    }

    // Case 4: the probe itself fails. A working tunnel must NOT be downgraded --
    // otherwise a missing `ss` would show every reverse tunnel as degraded and
    // operators would learn to ignore the state.
    {
      const engine = new TunnelEngine({
        dataDir,
        localBinDir: binDir,
        forceNodeFallback: true,
        forwarderRunner: { prefix: ["node"], script: "forwarder.mjs" },
        createProcessHandle: async (s) => new Handle(s as { unitName: string }) as never,
      } as never);
      (engine as never as { ctxFor: (n: unknown) => { runner: unknown } }).ctxFor = () => ({
        runner: {
          kind: "local" as const,
          async run(cmd: string[]) {
            const joined = cmd.join(" ");
            if (joined.includes("ss -ltnH")) throw new Error("probe unavailable");
            if (joined.includes("which")) return { stdout: "/usr/bin/ssh\n", stderr: "", exitCode: 0 };
            return { stdout: "", stderr: "", exitCode: 0 };
          },
          async writeFile() { return undefined; }
        },
        binDir, cfgDir: dataDir, dataDir, name: "foreign",
      });
      await engine.deploy(spec);
      const st = await engine.status("rev-1");
      if (st === "running") ok("an unavailable probe does not downgrade a working tunnel");
      else bad("an unavailable probe does not downgrade a working tunnel", String(st));
    }

    // Case 5: a bracketed IPv6 listener. The naive `:\d+$` strip would leave
    // "[::1]" -- and the classifier must still recognise that as loopback.
    {
      const engine = new TunnelEngine({
        dataDir,
        localBinDir: binDir,
        forceNodeFallback: true,
        forwarderRunner: { prefix: ["node"], script: "forwarder.mjs" },
        createProcessHandle: async (s) => new Handle(s as { unitName: string }) as never,
      } as never);
      (engine as never as { ctxFor: (n: unknown) => { runner: unknown } }).ctxFor = () => ({
        runner: makeRunner("[::1]:8080"),
        binDir, cfgDir: dataDir, dataDir, name: "foreign",
      });
      await engine.deploy(spec);
      const st = await engine.status("rev-1");
      if (st === "degraded") ok("a bracketed IPv6 loopback listener is recognised as loopback");
      else bad("a bracketed IPv6 loopback listener is recognised as loopback", String(st));
    }

    fsmod.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
  if (failures.length > 0) process.exitCode = 1;
}

void main();
assert.ok(true);
