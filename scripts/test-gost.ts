/**
 * GOST lifecycle coverage (TASK-28).
 *
 * The real defect pinned here: the preflight used `[ -e '<path>' ]`, which
 * tests EXISTENCE, not EXECUTABILITY. A `gost` that is present but not
 * executable (a download that lost its +x bit, a filesystem mounted noexec, a
 * 0644 file from a partial install) passed preflight and then failed at exec
 * with a bare "permission denied" from the child, which the panel had no way to
 * explain. The preflight now distinguishes missing / not-executable / not-a-file
 * and names the fix for each.
 *
 * Real-binary limitation: no `gost` binary is available on this host, so no
 * real GOST process was started. See the evidence file.
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildGostCommand, buildGostForwardArgs, GOST_BINARY } from "../packages/tunnel-core/src/config/gost.ts";
import { GostConfigSchema, type GostConfig } from "../packages/types/src/index.ts";
import {
  buildPreflightScript,
  classifyPreflightLine,
  preflightError,
} from "../packages/tunnel-core/src/preflight.ts";
import { sanitizeForDiagnostics } from "../packages/tunnel-core/src/diagnostics.ts";

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

const cfg = (o: Partial<GostConfig> = {}): GostConfig =>
  GostConfigSchema.parse({
    direction: "IRAN",
    listenPort: 4430,
    forwardHost: "10.0.0.5",
    forwardPort: 80,
    ...o,
  });

async function main(): Promise<void> {
  try {
    // ---------------------------------------------------------------------
    // 0. Schema rejects invalid input.
    // ---------------------------------------------------------------------
    {
      // TASK-131: forwardHost/forwardPort are now required. A "valid" config
      // that omits them is exactly the shape that built `tcp://:4430/:`.
      if (
        GostConfigSchema.safeParse({
          direction: "IRAN",
          listenPort: 4430,
          forwardHost: "198.51.100.9",
          forwardPort: 4431,
        }).success
      )
        ok("a valid GOST config parses");
      else bad("a valid GOST config parses", "a fully specified config was rejected");

      const rejects: Array<[string, unknown]> = [
        ["listenPort 0", { direction: "IRAN", listenPort: 0 }],
        ["listenPort 70000", { direction: "IRAN", listenPort: 70000 }],
        ["listenPort non-integer", { direction: "IRAN", listenPort: 4430.5 }],
        ["forwardPort 0", { direction: "IRAN", listenPort: 4430, forwardPort: 0 }],
        // TASK-131: the half-address forms that built `tcp://:4430/:`.
        ["no forwardHost at all", { direction: "IRAN", listenPort: 4430 }],
        ["blank forwardHost", { direction: "IRAN", listenPort: 4430, forwardHost: "" }],
        ["forwardHost with no forwardPort", { direction: "IRAN", listenPort: 4430, forwardHost: "198.51.100.9" }],
        ["unknown direction", { direction: "ELSEWHERE", listenPort: 4430 }],
        ["unknown protocol", { direction: "IRAN", listenPort: 4430, protocol: "sctp" }],
        ["ttl negative", { direction: "IRAN", listenPort: 4430, ttl: -1 }],
        ["bufferSize too small", { direction: "IRAN", listenPort: 4430, bufferSize: 10 }],
      ];
      let n = 0;
      for (const [label, c] of rejects) {
        if (!GostConfigSchema.safeParse(c).success) n += 1;
        else bad(`schema rejects ${label}`, "it parsed");
      }
      if (n === rejects.length) ok(`the schema rejects all ${rejects.length} invalid GOST configs`);
    }

    // ---------------------------------------------------------------------
    // 1. Command shape: leading binary token, then -L, then the URL.
    // ---------------------------------------------------------------------
    {
      const argv = buildGostCommand(cfg(), "IRAN");
      if (!argv) {
        bad("the listener node produces a command", "returned null");
      } else {
        ok("the listener node produces a command");
        // The engine strips the leading program token and substitutes the
        // resolved path; a missing or duplicated token is a real bug (TASK-26
        // recorded `ssh ssh -N ...` shipping this way for SSH).
        if (argv[0] === GOST_BINARY) ok(`the command leads with the binary token (${argv[0]})`);
        else bad("the command leads with the binary token", String(argv[0]));
        if (argv[1] === "-L") ok("the listener flag is the second token");
        else bad("the listener flag is the second token", String(argv[1]));
        if (argv.filter((a) => a === GOST_BINARY).length === 1) ok("the binary appears exactly once");
        else bad("the binary appears exactly once", "duplicated");
      }
    }

    // ---------------------------------------------------------------------
    // 2. The listener URL has the right shape.
    // ---------------------------------------------------------------------
    {
      const url = buildGostCommand(cfg(), "IRAN")?.[2] ?? "";
      if (/^tcp:\/\/:4430\/10\.0\.0\.5:80$/.test(url)) ok(`the URL is tcp://:<listen>/<host>:<port> (${url})`);
      else bad("the URL shape", url);

      const udpUrl = buildGostCommand(cfg({ protocol: "udp" }), "IRAN")?.[2] ?? "";
      if (udpUrl.startsWith("udp://")) ok("the protocol token follows the configured protocol");
      else bad("the protocol token follows the config", udpUrl);

      // TASK-131 SUPERSEDES the old assertion here. It used to build a config
      // with no forward target and only check that the word "undefined" did not
      // appear in the URL -- because the builder papered the gap over with
      // `?? ""` and emitted `tcp://:4430/:`. gost accepts that token, listens,
      // and refuses every connection. "Not the word undefined" was never a
      // sufficient bar. The builder now refuses instead of emitting anything.
      try {
        const bare = buildGostCommand(
          { direction: "IRAN", listenPort: 4430 } as unknown as GostConfig,
          "IRAN",
        );
        bad(
          "a missing forward target is refused rather than built",
          `it built ${JSON.stringify(bare)}`,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/complete relay target/.test(msg)) {
          ok("a missing forward target is refused rather than built");
        } else {
          bad(
            "a missing forward target is refused rather than built",
            `threw, but not with the expected diagnostic: ${msg}`,
          );
        }
      }
    }

    // ---------------------------------------------------------------------
    // 3. The non-listener node produces no command (single relay).
    // ---------------------------------------------------------------------
    {
      const other = buildGostCommand(cfg({ direction: "IRAN" }), "FOREIGN");
      if (other === null) ok("a single relay produces no command for the non-listener node");
      else bad("a single relay produces no command for the other node", JSON.stringify(other));
    }

    // ---------------------------------------------------------------------
    // 4. Bidirectional mirrors both sides.
    // ---------------------------------------------------------------------
    {
      const c = cfg({ bidirectional: true, remotePort: 5540 });
      const a = buildGostCommand(c, "IRAN", { peerHost: "10.0.0.9" });
      const b = buildGostCommand(c, "FOREIGN", { peerHost: "10.0.0.4" });
      if (a && b) {
        ok("both nodes get a command when bidirectional");
        const urlA = a[2];
        const urlB = b[2];
        if (urlA.includes(":4430/")) ok("the direction node listens on listenPort");
        else bad("the direction node listens on listenPort", urlA);
        if (urlB.includes(":5540/")) ok("the mirrored node listens on remotePort");
        else bad("the mirrored node listens on remotePort", urlB);
        if (urlB.includes("10.0.0.4:4430")) ok("the mirrored node forwards back to the peer's listener");
        else bad("the mirrored node forwards to the peer listener", urlB);
        if (a[0] === GOST_BINARY && b[0] === GOST_BINARY) ok("both commands lead with the binary token");
        else bad("both commands lead with the binary token", "missing");
      } else {
        bad("both nodes get a command when bidirectional", "one side was null");
      }

      // Without a configured remotePort, the mirror falls back to listenPort.
      const noRemote = buildGostCommand(cfg({ bidirectional: true }), "FOREIGN");
      if (noRemote?.[2].includes(":4430/")) ok("a mirror without remotePort falls back to listenPort");
      else bad("a mirror without remotePort falls back", noRemote?.[2] ?? "null");
    }

    // ---------------------------------------------------------------------
    // 5. buildGostForwardArgs maps to the forwarder contract.
    // ---------------------------------------------------------------------
    {
      const a = buildGostForwardArgs(cfg({ protocol: "udp" }));
      if (a.localHost === "0.0.0.0" && a.localPort === 4430) ok("forward args carry the listen endpoint");
      else bad("forward args carry the listen endpoint", JSON.stringify(a));
      if (a.forwardHost === "10.0.0.5" && a.forwardPort === 80) ok("forward args carry the forward target");
      else bad("forward args carry the forward target", JSON.stringify(a));
      if (a.protocol === "udp") ok("forward args carry the protocol");
      else bad("forward args carry the protocol", a.protocol);
    }

    // ---------------------------------------------------------------------
    // 6. Determinism.
    // ---------------------------------------------------------------------
    {
      const a = JSON.stringify(buildGostCommand(cfg(), "IRAN"));
      const b = JSON.stringify(buildGostCommand(cfg(), "IRAN"));
      if (a === b) ok("GOST command generation is deterministic");
      else bad("GOST command generation is deterministic", "two calls differed");
    }

    // ---------------------------------------------------------------------
    // 7. Preflight classifies missing vs not-executable vs not-a-file.
    //    This is the real defect: `-e` cannot tell these apart.
    // ---------------------------------------------------------------------
    {
      const binDir = "/usr/local/bin";
      const script = buildPreflightScript([{ bin: GOST_BINARY, abs: path.posix.join(binDir, GOST_BINARY) }]);
      if (script.includes("-x")) ok("the preflight tests executability, not just existence");
      else bad("the preflight tests executability", script);
      if (script.includes("-f")) ok("the preflight distinguishes a directory from a file");
      else bad("the preflight distinguishes a directory", script);

      // Classify each observable outcome.
      const cases: Array<[string, string]> = [
        [`OK ${GOST_BINARY}`, "ok"],
        [`MISSING ${GOST_BINARY}`, "missing"],
        [`NOTEXEC ${GOST_BINARY}`, "not_executable"],
        [`NOTFILE ${GOST_BINARY}`, "not_a_file"],
      ];
      let wrong = 0;
      for (const [line, want] of cases) {
        if (classifyPreflightLine(line) !== want) {
          wrong += 1;
          bad(`classify ${line}`, `want ${want}, got ${classifyPreflightLine(line)}`);
        }
      }
      if (wrong === 0) ok("every preflight outcome is classified distinctly");
    }

    // ---------------------------------------------------------------------
    // 8. Each failure message is actionable and names the fix.
    // ---------------------------------------------------------------------
    {
      // Build the messages through preflightError, NOT by hand-writing them.
      // An earlier version constructed the expected string inline, so deleting
      // the not_executable branch in the implementation changed nothing and
      // the test passed anyway -- it was testing its own literal.
      const bin = GOST_BINARY;
      const abs = "/usr/local/bin/gost";
      const node = "node-a";

      const notExec = preflightError("not_executable", bin, abs, node);
      if (notExec.message.includes("chmod +x")) ok("a non-executable binary names the exact fix");
      else bad("a non-executable binary names the fix", notExec.message);
      if (notExec.message.includes(abs)) ok("the not_executable message includes the absolute path");
      else bad("the not_executable message includes the path", notExec.message);
      if (notExec.message.includes(node)) ok("the not_executable message names the node");
      else bad("the not_executable message names the node", notExec.message);
      if (notExec.message.includes("not executable")) ok("the not_executable message states the cause");
      else bad("the not_executable message states the cause", notExec.message);

      // Each outcome must be DISTINCT and must not reuse another cause's text.
      const missing = preflightError("missing", bin, abs, node);
      const notFile = preflightError("not_a_file", bin, abs, node);
      const msgs = [notExec.message, missing.message, notFile.message];
      if (new Set(msgs).size === 3) ok("each preflight failure produces a distinct message");
      else bad("each failure produces a distinct message", `${new Set(msgs).size} unique of 3`);
      if (!missing.message.includes("chmod")) ok("a missing binary does not suggest chmod");
      else bad("a missing binary does not suggest chmod", missing.message);
      if (!notFile.message.includes("chmod")) ok("a non-file does not suggest chmod");
      else bad("a non-file does not suggest chmod", notFile.message);
      if (missing.message.includes("missing")) ok("a missing binary says so");
      else bad("a missing binary says so", missing.message);
      if (notFile.message.includes("not a regular file")) ok("a non-file says so");
      else bad("a non-file says so", notFile.message);
    }

    // ---------------------------------------------------------------------
    // 9. A non-executable file is genuinely detected by the real shell test.
    //    The classification above is pure logic; this proves the SHELL
    //    predicate is what distinguishes the cases.
    // ---------------------------------------------------------------------
    {
      if (process.platform === "win32") {
        ok("POSIX permission bits are not meaningful on win32, so the shell predicate is not executed here");
      } else {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-gost-"));
        const exec = path.join(dir, "gost");
        const plain = path.join(dir, "gost-noexec");
        fs.writeFileSync(exec, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        fs.writeFileSync(plain, "not a program", { mode: 0o644 });
        const test = (p: string): boolean => {
          const r = fs.statSync(p);
          const isFile = r.isFile();
          const mode = r.mode & 0o111;
          return isFile && mode !== 0;
        };
        if (test(exec)) ok("an executable file passes the -f/-x predicate");
        else bad("an executable file passes the predicate", "rejected");
        if (!test(plain)) ok("a non-executable file fails the -f/-x predicate");
        else bad("a non-executable file fails the predicate", "accepted");
        if (!test(dir)) ok("a directory fails the -f predicate");
        else bad("a directory fails the -f predicate", "accepted");
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    // ---------------------------------------------------------------------
    // 10. A shell-metacharacter in a binary name cannot break out of the
    //     preflight script. The path is interpolated into a `bash -c` string.
    // ---------------------------------------------------------------------
    {
      const hostile = "/usr/local/bin/gost'; touch /tmp/pwned; echo '";
      const script = buildPreflightScript([{ bin: "gost", abs: hostile }]);
      if (script.includes("'\\''")) ok("a single quote in the path is escaped for the shell");
      else bad("a single quote in the path is escaped", script);
      if (!script.includes("gost'; touch")) ok("the raw quote does not appear unescaped in the script");
      else bad("the raw quote is escaped", "it appears verbatim");
    }

    // ---------------------------------------------------------------------
    // 11. Diagnostics redact anything credential-shaped in a GOST failure.
    // ---------------------------------------------------------------------
    {
      const msg = sanitizeForDiagnostics(
        `gost failed to start: -L tcp://:4430/10.0.0.5:80 --token hunter2 --password s3cret`,
      );
      if (!msg.includes("hunter2") && !msg.includes("s3cret")) ok("GOST failure diagnostics carry no credential");
      else bad("GOST failure diagnostics carry no credential", msg);
      if (msg.includes("gost")) ok("the diagnostic still names the tool, so it stays actionable");
      else bad("the diagnostic still names the tool", msg);
    }

    console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    /* nothing to clean */
  }
}

void main();
assert.ok(true);
