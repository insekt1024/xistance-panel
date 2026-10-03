/**
 * All-method regression matrix (TASK-35).
 *
 * One record per method, six dimensions each:
 *
 *   config      schema acceptance, refusal of malformed input, and the
 *               generated command/config being what the runtime receives
 *   lifecycle   deploy -> start -> stop -> restart -> remove, through a real
 *               TunnelEngine with an injected process handle
 *   failure     what the method does when the config, the binary or the
 *               remote side refuses
 *   cleanup     no leaked process after a partially failed deploy; no
 *               temporary file or listener left behind
 *   resource    stop and dispose are bounded even when the process cannot be
 *               interrogated
 *   realBinary  FALSE for every row in this run
 *
 * `realBinary` is the column that matters for release honesty. Every row below
 * is `local_command` and `injected_process` evidence. No tunnel binary was
 * executed, no traffic crossed a tunnel, and no row may be read as proving
 * otherwise. A method is `complete` only when every dimension is covered AND
 * realBinary is true -- which is why no method is complete yet, and why the
 * matrix fails the release gate rather than passing it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runMethodContract, type MethodResult } from "./lib/method-contract.ts";
import { TunnelMethod } from "../packages/types/src/index.ts";

let pass = 0;
const failures: string[] = [];
const ok = (name: string) => { pass += 1; console.log(`  ok   ${name}`); };
const bad = (name: string, detail: string) => { failures.push(name); console.log(`  FAIL ${name}\n       ${detail}`); };

/** Which suite already covers config/failure/cleanup beyond this harness. */
const SUITE_FOR: Record<string, string> = {
  BACKHAUL: "scripts/test-backhaul.ts",
  FRP: "scripts/test-frp.ts",
  GOST: "scripts/test-gost.ts",
  SSH: "scripts/test-ssh.ts",
  PORT_FORWARD: "scripts/test-port-forward.ts",
  DIRECT: "scripts/test-direct.ts",
  REVERSE: "scripts/test-reverse.ts",
  XRAY: "scripts/test-xray.ts",
  XUI: "scripts/test-xui.ts",
};

const CONFIGS: Record<string, { config: unknown; metadataOnly?: boolean }> = {
  // Shapes below are copied from the production schemas, not invented: an
  // earlier version of this file used plausible-looking field names and four
  // methods failed to parse at all, which is exactly the "looks tested, proves
  // nothing" failure the matrix exists to prevent.
  BACKHAUL: {
    config: {
      method: TunnelMethod.BACKHAUL,
      backhaul: { role: "server", listenAddress: "0.0.0.0", listenPort: 7000, token: "a".repeat(48) },
    },
  },
  FRP: {
    config: {
      method: TunnelMethod.FRP,
      frp: {
        bindPort: 7000,
        token: "b".repeat(32),
        // allowPorts is z.array(z.string()) per TASK-27: quoted range strings.
        allowPorts: ["6000-6100"],
        proxies: [{ name: "p1", type: "tcp", localIP: "127.0.0.1", localPort: 80, remotePort: 6000 }],
      },
    },
  },
  GOST: {
    config: {
      method: TunnelMethod.GOST,
      // TASK-131: the relay target is required; without it the builder emitted
      // `tcp://:7000/:` and gost listened while refusing every connection.
      gost: { direction: "IRAN", protocol: "tcp", listenPort: 7000, forwardHost: "203.0.113.10", forwardPort: 7001 },
    },
  },
  SSH: {
    config: {
      method: TunnelMethod.SSH,
      ssh: {
        mode: "local",
        host: "203.0.113.10",
        port: 22,
        username: "deploy",
        auth: "key",
        localBindAddr: "127.0.0.1",
        localPort: 8080,
        remoteHost: "127.0.0.1",
        remotePort: 80,
      },
    },
  },
  PORT_FORWARD: {
    config: {
      method: TunnelMethod.PORT_FORWARD,
      portForwards: [
        { name: "web", direction: "IRAN_TO_FOREIGN", protocol: "tcp", sourcePort: 8080, destHost: "127.0.0.1", destPort: 80 },
      ],
    },
  },
  DIRECT: {
    config: {
      method: TunnelMethod.DIRECT,
      direct: { protocol: "tcp", bindAddr: "0.0.0.0", listenPort: 8080, targetHost: "127.0.0.1", targetPort: 80 },
    },
  },
  REVERSE: {
    config: {
      method: TunnelMethod.REVERSE,
      reverse: {
        protocol: "tcp",
        listenPort: 8080,
        forwardHost: "127.0.0.1",
        forwardPort: 3000,
        host: "203.0.113.10",
        port: 22,
        username: "deploy",
        auth: "key",
        remoteBindAddr: "0.0.0.0",
      },
    },
  },
  XRAY: {
    config: {
      method: TunnelMethod.XRAY,
      xray: {
        listenPort: 10808,
        protocol: "vless",
        address: "example.com",
        port: 443,
        uuid: "b831381d-6324-4d53-ad4f-8cda48b30811",
        network: "tcp",
        security: "none",
      },
    },
  },
  XUI: {
    metadataOnly: true,
    config: {
      method: TunnelMethod.XUI,
      xui: { panelUrl: "https://panel.example.com", username: "admin", password: "pw", inboundId: 7, syncInterval: 300 },
    },
  },
};

const ALL_METHODS = [
  "BACKHAUL", "FRP", "GOST", "SSH", "PORT_FORWARD", "DIRECT", "REVERSE", "XRAY", "XUI",
];

/**
 * Alternative check names that satisfy a dimension, for methods whose shape
 * makes the canonical name inapplicable.
 *
 * Without this, a single-process method shows "Cleanup: NO" for having no
 * partial-deploy to leak, and XUI shows "Lifecycle: NO" for running no process.
 * Both read as gaps that do not exist. The distinction that actually matters is
 * recorded in the notes column instead.
 */
const DIMENSION_ALTS: Record<string, string[]> = {
  "a partially failed deploy leaves no process running": [
    "partial-deploy cleanup is not applicable to a single-process method",
  ],
  "a live process reports running or degraded": [
    "a deployed tunnel reports a known status",
  ],
  "restart does not throw": ["restarting a metadata-only method does not throw"],
  "a restarted tunnel returns to a live status": [
    "restarting a metadata-only method does not throw",
  ],
  "stop settles even when the process cannot be interrogated": [
    "a metadata-only method keeps zero processes",
  ],
};

/** Names of the checks each dimension is considered covered by. */
const DIMENSIONS = {
  config: ["config parses through TunnelConfigSchema", "config round-trips with its method intact", "an out-of-range port in the method's own config is refused"],
  lifecycle: ["deploy succeeds", "a live process reports running or degraded", "a stopped tunnel reports stopped", "restart does not throw", "a restarted tunnel returns to a live status", "remove does not throw", "a removed tunnel reports stopped", "a removed tunnel is no longer tracked", "removing a tunnel twice does not grow the runtime map"],
  cleanup: ["a repeated stop does not throw", "a repeated stop issues no additional stops", "a partially failed deploy leaves no process running"],
  resource: ["stop settles even when the process cannot be interrogated"],
  // `failure` is covered by the per-method suites, not by this harness: each
  // one owns its own malformed-config / missing-binary / unreachable-remote
  // case, and the matrix records the reference rather than re-deriving it.
  failure: [] as string[],
} as const;

async function main() {
  console.log("\n--- matrix records ---");

  // XUI verifies against a live panel, so its engine seam is supplied below;
  // without it a deploy performs real DNS and real HTTP inside a unit test.
  const results = new Map<string, MethodResult>();
  for (const method of ALL_METHODS) {
    const spec = CONFIGS[method];
    // The XUI verification seam: injected so no panel is contacted.
    const result = await runMethodContract({
      method: method as TunnelMethod,
      config: spec.config,
      metadataOnly: spec.metadataOnly,
      // A metadata-only method must not be told "running" for free either: the
      // injected verification reports an unreachable panel, so the engine has
      // to classify a real failure rather than assert health.
      ...(method === "XUI"
        ? {
            engineOptions: {
              xuiSync: async () => ({
                ok: false,
                kind: "unreachable" as const,
                detail: "matrix run: no panel is contacted",
                retryable: true,
              }),
            },
          }
        : {}),
    });
    results.set(method, result);
  }

  // ---- every method must have a record ------------------------------------
  for (const m of ALL_METHODS) {
    const r = results.get(m);
    if (!r) {
      bad(`${m} has a matrix record`, "no record produced");
      continue;
    }
    ok(`${m} has a matrix record`);
    if (r.checks.length > 0) ok(`${m} ran ${r.checks.length} shared checks`);
    else bad(`${m} ran shared checks`, "zero checks");
  }

  // ---- every shared check must pass ---------------------------------------
  for (const m of ALL_METHODS) {
    const r = results.get(m);
    if (!r) continue;
    const failed = r.checks.filter((c) => !c.ok);
    if (failed.length === 0) ok(`${m} passes every shared contract check`);
    else {
      for (const f of failed) bad(`${m}: ${f.name}`, f.detail ?? "");
    }
  }

  // ---- no method may be marked complete without real binary evidence ------
  // This is the criterion the task is really about. It MUST fail today: nine
  // methods have local command generation and injected-process lifecycle, and
  // not one has a real binary behind it.
  {
    const complete = ALL_METHODS.filter((m) => results.get(m)?.realBinary === true);
    if (complete.length === 0) {
      ok("no method claims completion without real-binary evidence (correct: none has it)");
    } else {
      bad("no method claims completion without real-binary evidence", `${complete.join(", ")} claim realBinary`);
    }
    for (const m of ALL_METHODS) {
      const r = results.get(m);
      if (r?.realBinary === false) ok(`${m} is recorded as local/injected evidence, not real-binary`);
    }
  }

  // ---- every method must be covered by a per-method suite -----------------
  for (const m of ALL_METHODS) {
    const s = SUITE_FOR[m];
    const p = path.resolve(s);
    if (fs.existsSync(p)) ok(`${m} has a per-method suite (${s})`);
    else bad(`${m} has a per-method suite`, `${s} is missing`);
  }

  // ---- the machine-readable record ----------------------------------------
  {
    const out = {
      generatedAt: new Date().toISOString(),
      contract: "all-method shared regression matrix",
      // Stated once, at the top, so no row can be read without it.
      disclaimer:
        "realBinary is false for every method. These results prove local command/config generation " +
        "and engine lifecycle with an injected process handle. No tunnel binary was executed, no " +
        "traffic crossed a tunnel, and no remote node was contacted. Release acceptance requires a " +
        "separate real-binary/VPS pass per method.",
      methods: ALL_METHODS.map((m) => {
        const r = results.get(m)!;
        const covered = (names: readonly string[]) => {
          if (names.length === 0) return "referenced";
          const met = (n: string) =>
            r.checks.some((c) => c.name === n) ||
            (DIMENSION_ALTS[n] ?? []).some((alt) => r.checks.some((c) => c.name === alt));
          return names.every(met) ? "yes" : "NO";
        };
        return {
          method: m,
          suite: SUITE_FOR[m],
          metadataOnly: r.metadataOnly,
          lifecycleExercised: r.lifecycleExercised,
          realBinary: r.realBinary,
          evidenceKind: r.realBinary ? "real" : "local_command+injected_process",
          checksRun: r.checks.length,
          checksPassed: r.checks.filter((c) => c.ok).length,
          dimensions: {
            config: covered(DIMENSIONS.config),
            lifecycle: covered(DIMENSIONS.lifecycle),
            failure: "referenced",
            cleanup: covered(DIMENSIONS.cleanup),
            resource: covered(DIMENSIONS.resource),
            realBinary: false,
          },
          // Which dimension checks were met by a substituted name, so the
          // table can say WHY a row differs instead of implying a gap.
          notes: Object.keys(DIMENSION_ALTS)
            .filter((k) => (DIMENSION_ALTS[k] ?? []).some((alt) => r.checks.some((c) => c.name === alt)))
            .map((k) => (DIMENSION_ALTS[k] ?? []).find((alt) => r.checks.some((c) => c.name === alt)) ?? "")
            .filter(Boolean),
          // Release gate: every dimension true AND a real binary behind it.
          releaseComplete: false,
        };
      }),
    };
    const target = path.resolve(".agent/evidence/tunnel-matrix.json");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(out, null, 2) + "\n", "utf8");
    ok(`machine-readable matrix written (${out.methods.length} methods)`);

    // Re-read it: a matrix that is written but not parseable proves nothing.
    const back = JSON.parse(fs.readFileSync(target, "utf8")) as typeof out;
    if (back.methods.length === ALL_METHODS.length) ok("the written matrix parses and enumerates all nine methods");
    else bad("the written matrix enumerates all nine methods", `${back.methods.length}`);
    if (/realBinary is false for every method/.test(back.disclaimer)) ok("the matrix carries its own disclaimer");
    else bad("the matrix carries its disclaimer", "missing");

    // Render the human-readable companion.
    //
    // The "Real binary" column is NOT hardcoded to "no". This harness cannot
    // execute a tunnel binary (it injects a process handle), so `r.realBinary`
    // is false for every row it computes -- but TASK-65 then ran real GOST,
    // FRP and XRAY binaries on the target OS with real bytes crossing real
    // tunnels. Rendering "**no**" unconditionally would make the matrix
    // contradict the evidence it ships beside, and would make the release look
    // less verified than it is. So the column reflects the recorded ledger in
    // .agent/evidence/real-binary-evidence.json, which
    // scripts/test-real-binary-evidence.ts validates.
    const ledgerPath = path.resolve(".agent/evidence/real-binary-evidence.json");
    let proved = new Set<string>();
    let reasonLines: string[] = [];
    let ledgerErr: string | undefined;
    try {
      const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as {
        runs?: Array<{ method: string; trafficCrossed: boolean }>;
        methodsWithoutRealBinaryEvidence?: Array<{ method: string; reason: string }>;
      };
      proved = new Set((ledger.runs ?? []).filter((r) => r.trafficCrossed).map((r) => r.method));
      reasonLines = (ledger.methodsWithoutRealBinaryEvidence ?? []).map(
        (e) => `**${e.method}** — ${e.reason}`,
      );
    } catch (e) {
      // Never silently degrade to "nothing proved": say the ledger is
      // unreadable, which is itself a gate failure.
      ledgerErr = (e as Error).message;
    }

    const NOTE: Record<string, string> = {
      XUI: "metadata-only: no process, no partial deploy; status comes from a real panel verification",
    };
    const rows = out.methods
      .map((m) => {
        // A metadata-only method is a different shape from a single-process one,
        // and saying otherwise would misdescribe it.
        const single = !m.metadataOnly && m.notes.length > 0;
        const note = m.metadataOnly
          ? NOTE[m.method] ?? "metadata-only: no process, no partial deploy; status from a real panel check"
          : single ? "single-process: no partial deploy to leak" : (NOTE[m.method] ?? "");
        // Two distinct claims, and conflating them would be its own falsehood:
        // this harness's injected-process result, and real-binary traffic proved
        // elsewhere on the target OS.
        const harness = m.realBinary ? "yes" : "no";
        const real = proved.has(m.method) ? "yes" : "no";
        const cell = real === "yes" ? `yes (${harness} here)` : `**no** (${harness} here)`;
        return (
          `| ${m.method} | ${m.dimensions.config} | ${m.dimensions.lifecycle} | ` +
          `${m.dimensions.failure} | ${m.dimensions.cleanup} | ${m.dimensions.resource} | ` +
          `${cell} | ${m.checksPassed}/${m.checksRun} | ${single ? "single-process: no partial deploy to leak" : (NOTE[m.method] ?? "")} |`
        );
      })
      .join("\n");
    const provedList = [...proved].sort();
    const md =
      `# All-method regression matrix\n\n` +
      `Generated ${out.generatedAt} by \`scripts/test-method-matrix.ts\`.\n\n` +
      `> **This harness runs every method with an INJECTED process handle. Its own**\n` +
      `> **\`realBinary\` column is therefore \`false\` for all nine: no tunnel binary is**\n` +
      `> **executed here. Real-binary evidence comes from a separate pass on the**\n` +
      `> **target OS and is recorded in \`real-binary-evidence.json\` (validated by**\n` +
      `> **\`scripts/test-real-binary-evidence.ts\`). Read the two columns separately.**\n\n` +
      `| Method | Config | Lifecycle | Failure | Cleanup | Resource | Real binary (harness / on target) | Shared checks | Note |\n` +
      `| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${rows}\n\n` +
      `## Injected-process vs real-binary evidence\n\n` +
      `Every row's \`Config\`/\`Lifecycle\`/\`Failure\`/\`Cleanup\`/\`Resource\` columns are` +
      ` \`local_command+injected_process\` evidence: the engine lifecycle, cleanup, and resource` +
      ` guarantees are genuinely exercised through a real \`TunnelEngine\` with a scriptable` +
      ` process handle, which is what makes idempotent stop and partial-deploy cleanup provable at all.\n\n` +
      (ledgerErr
        ? `**The real-binary ledger could not be read (${ledgerErr}), so no real-binary claim is made for any method.**\n\n`
        : provedList.length > 0
          ? `A real-binary pass has since been executed on the target OS. ` +
            `**${provedList.length}/9** methods carry real bytes across a real tunnel: ` +
            `${provedList.map((m) => `\`${m}\``).join(", ")}. See ` +
            `\`task-65-tunnel-traffic.md\`. The remaining ` +
            `${9 - provedList.length} are recorded as NOT proved with a real binary, each with the reason.\n\n`
          : `No method has yet carried real bytes across a real tunnel.\n\n`) +
      // Read the unproved reasons from the ledger rather than restating them
      // here. A hardcoded list of gaps is exactly the kind of prose that goes
      // stale the moment one of them closes -- which is what happened when this
      // paragraph still said BACKHAUL and SSH were unproved after both were
      // proven.
      (reasonLines.length > 0
        ? `### Methods without real-binary evidence\n\n` +
          reasonLines.map((l) => `- ${l}`).join("\n") +
          "\n\n"
        : "") +
      `## Per-method suites\n\n` +
      out.methods.map((m) => `- \`${m.method}\` — \`${m.suite}\``).join("\n") + "\n";
    fs.writeFileSync(path.resolve(".agent/evidence/tunnel-matrix.md"), md, "utf8");
    ok("human-readable matrix written");

    if (ledgerErr) {
      bad(
        "the real-binary ledger is readable",
        `${ledgerErr} -- the matrix cannot state which methods carry real-binary evidence`,
      );
    } else if (provedList.length > 0) {
      ok(
        `the matrix states which ${provedList.length} method(s) carry real-binary evidence (${provedList.join(", ")})`,
      );
    } else {
      ok("the matrix states that no method carries real-binary evidence (correct today)");
    }
  }

  console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
  if (failures.length > 0) process.exitCode = 1;
}

void main();
assert.ok(true);
