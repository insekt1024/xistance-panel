/**
 * BACKHAUL lifecycle coverage (TASK-26).
 *
 * Scope note: this covers config generation, schema validation, the plan the
 * engine builds, and file permissions. It does NOT drive real tunnel traffic --
 * that needs the approved VPS fixture, per the task's technical note, and no
 * real `backhaul` binary is available on this host. That limitation is recorded
 * in the evidence rather than papered over with a fake that proves nothing.
 *
 * The defect pinned here is a real one: `writeFile` accepts a `mode` and NO
 * method ever passed one, so every generated config -- including BACKHAUL's,
 * which contains the shared `token = "..."` -- was written world-readable
 * (0644) on the target node. On a shared VPS any local user could read the
 * token and connect to the tunnel.
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BackhaulConfigSchema, type BackhaulConfig } from "../packages/types/src/index.ts";
import { buildBackhaulConfig } from "../packages/tunnel-core/src/config/backhaul.ts";
import { buildFrpPair } from "../packages/tunnel-core/src/config/frp.ts";
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

const SECRET_TOKEN = "s3cr3t-shared-backhaul-token-value-9f2a";

const baseCfg = (o: Partial<BackhaulConfig> = {}): BackhaulConfig =>
  BackhaulConfigSchema.parse({
    role: "client",
    listenPort: 443,
    remoteHost: "tunnel.example.com",
    token: SECRET_TOKEN,
    portMap: [{ local: 8080, remote: 443 }],
    ...o,
  });

async function main(): Promise<void> {
  try {
    // ---------------------------------------------------------------------
    // 0. Schema rejects invalid transport and out-of-range values.
    // ---------------------------------------------------------------------
    {
      const badTransport = [
        { transport: "quic9" },
        { transport: "" },
        { transport: 123 },
      ];
      let rejected = 0;
      for (const b of badTransport) {
        const r = BackhaulConfigSchema.safeParse({ ...baseCfg(), ...b });
        if (!r.success) rejected += 1;
        else bad(`schema rejects transport ${JSON.stringify(b.transport)}`, "it parsed");
      }
      if (rejected === badTransport.length) ok("the schema rejects every invalid transport");

      const badNumeric = [
        { listenPort: 0 },
        { listenPort: 70000 },
        { listenPort: 1.5 },
        { heartbeat: 0 },
        { heartbeat: 601 },
        { channelSize: 0 },
        { muxConcurrency: 2049 },
      ];
      let nrej = 0;
      for (const b of badNumeric) {
        const r = BackhaulConfigSchema.safeParse({ ...baseCfg(), ...b });
        if (!r.success) nrej += 1;
        else bad(`schema rejects ${JSON.stringify(b)}`, "it parsed");
      }
      if (nrej === badNumeric.length) ok("the schema rejects out-of-range numeric settings");

      // An empty token must be refused: it would deploy a tunnel anyone can join.
      const r = BackhaulConfigSchema.safeParse({ ...baseCfg(), token: "" });
      if (!r.success) ok("an empty token is rejected");
      else bad("an empty token is rejected", "it parsed");

      // A portMap entry out of range must be refused too.
      const pm = BackhaulConfigSchema.safeParse({ ...baseCfg(), portMap: [{ local: 0, remote: 443 }] });
      if (!pm.success) ok("an out-of-range portMap entry is rejected");
      else bad("an out-of-range portMap entry is rejected", "it parsed");
    }

    // ---------------------------------------------------------------------
    // 1. Generated TOML is deterministic.
    // ---------------------------------------------------------------------
    {
      const a = buildBackhaulConfig(baseCfg(), "server");
      const b = buildBackhaulConfig(baseCfg(), "server");
      if (a === b) ok("server config generation is deterministic");
      else bad("server config generation is deterministic", "two calls differed");

      const c = buildBackhaulConfig(baseCfg(), "client");
      const d = buildBackhaulConfig(baseCfg(), "client");
      if (c === d) ok("client config generation is deterministic");
      else bad("client config generation is deterministic", "two calls differed");

      if (a.endsWith("\n")) ok("the generated config ends with a newline");
      else bad("the generated config ends with a newline", JSON.stringify(a.slice(-8)));
    }

    // ---------------------------------------------------------------------
    // 2. Roles emit the right sections and do not leak each other's keys.
    // ---------------------------------------------------------------------
    {
      const server = buildBackhaulConfig(baseCfg(), "server");
      const client = buildBackhaulConfig(baseCfg(), "client");
      if (server.includes("[server]") && !server.includes("[client]")) ok("the server role emits only [server]");
      else bad("the server role emits only [server]", server.slice(0, 80));
      if (client.includes("[client]") && !client.includes("[server]")) ok("the client role emits only [client]");
      else bad("the client role emits only [client]", client.slice(0, 80));
      if (server.includes("bind_addr")) ok("the server emits bind_addr");
      else bad("the server emits bind_addr", "missing");
      if (client.includes("remote_addr")) ok("the client emits remote_addr");
      else bad("the client emits remote_addr", "missing");
      // The port map belongs to the server only.
      if (server.includes("ports = [") && !client.includes("ports = [")) ok("the port map is emitted on the server only");
      else bad("the port map is server-only", "leaked to the client");
    }

    // ---------------------------------------------------------------------
    // 3. Transport mapping is explicit and total.
    // ---------------------------------------------------------------------
    {
      const cases: Array<[string, boolean, string]> = [
        ["tcp", false, "tcp"],
        ["tcp", true, "tcpmux"],
        ["websocket", false, "ws"],
        ["websocket", true, "wsmux"],
        // v0.7.x has no quic transport; it must degrade to tcp, not emit
        // something the binary would reject at startup.
        ["quic", false, "tcp"],
        ["quic", true, "tcpmux"],
      ];
      let wrong = 0;
      for (const [transport, mux, want] of cases) {
        const out = buildBackhaulConfig(
          baseCfg({ transport: transport as never, multiplexing: mux }),
          "server",
        );
        const line = out.split("\n").find((l) => l.startsWith("transport = ")) ?? "";
        if (!line.includes(`"${want}"`)) {
          wrong += 1;
          bad(`transport ${transport}/mux=${mux}`, `want ${want}, got ${line}`);
        }
      }
      if (wrong === 0) ok(`all ${cases.length} transport/mux combinations map correctly`);
    }

    // ---------------------------------------------------------------------
    // 4. The token is present (it is required) but must never escape into
    //    diagnostics or logs.
    // ---------------------------------------------------------------------
    {
      const server = buildBackhaulConfig(baseCfg(), "server");
      if (server.includes(SECRET_TOKEN)) ok("the config contains the token (it must, to authenticate)");
      else bad("the config contains the token", "missing");
      if (/^token\s*=\s*"[^"]*"/m.test(server)) ok("the token line is well-formed TOML");
      else bad("the token line is well-formed", "no match");

      // Any diagnostic built from a config dump must not carry it.
      const dumped = sanitizeForDiagnostics(`failed to parse:\n${server}`);
      if (!dumped.includes(SECRET_TOKEN)) ok("sanitising a config dump strips the token");
      else bad("sanitising a config dump strips the token", "the token survived");
      // The KEY must survive redaction, otherwise the operator sees "***" with
      // no indication of what was redacted. Redaction collapses `token = "x"`
      // to `token=***`, so match on the key alone, not the original spacing.
      if (/\btoken\b/i.test(dumped)) ok("the redacted dump still names the key, so it stays diagnosable");
      else bad("the redacted dump still names the key", dumped.slice(0, 120));
      if (dumped.includes("***")) ok("the redacted value is visibly marked as redacted");
      else bad("the redacted value is marked", "no marker");
    }

    // ---------------------------------------------------------------------
    // 5. TOML quoting cannot be broken out of by a hostile token.
    // ---------------------------------------------------------------------
    {
      // A quote is escapable, so it must be escaped and stay on one line.
      const quoted = buildBackhaulConfig(baseCfg({ token: 'evil" quoted' }), "server");
      const tokenLine = quoted.split("\n").find((l) => l.startsWith("token = ")) ?? "";
      if (tokenLine.includes('\\"')) ok("a quote in the token is escaped, not line-breaking");
      else bad("a quote in the token is escaped", tokenLine);

      // A newline is NOT escapable into a single-line basic string, so it is
      // refused outright. Before the fix it passed through and the following
      // text was parsed as TOML -- a config-injection primitive via a field the
      // user supplies. Refusing is the correct outcome: no legitimate token,
      // host or port contains a control character.
      let injected = false;
      let refused = false;
      try {
        const out = buildBackhaulConfig(baseCfg({ token: 'evil\ninjected = "yes' }), "server");
        injected = out.includes("\ninjected = ");
      } catch {
        refused = true;
      }
      if (refused && !injected) ok("a newline in the token is refused, so no TOML key can be injected");
      else if (injected) bad("a newline in the token is refused", "injection succeeded");
      else bad("a newline in the token is refused", "it silently produced output");

      // A carriage return and a NUL are the same class of attack.
      for (const [label, payload] of [["carriage return", "a\rb"], ["NUL", "a\u0000b"]] as const) {
        let okRefused = false;
        try {
          buildBackhaulConfig(baseCfg({ token: payload }), "server");
        } catch {
          okRefused = true;
        }
        if (okRefused) ok(`a ${label} in the token is refused`);
        else bad(`a ${label} in the token is refused`, "it was accepted");
      }

      // Backslash escaping too.
      const bs = buildBackhaulConfig(baseCfg({ token: "a\\b" }), "server");
      const bsLine = bs.split("\n").find((l) => l.startsWith("token = ")) ?? "";
      if (bsLine.includes("\\\\")) ok("a backslash in the token is escaped");
      else bad("a backslash in the token is escaped", bsLine);
    }

    // ---------------------------------------------------------------------
    // 6. The port map renders remote=local in the right order.
    // ---------------------------------------------------------------------
    {
      const out = buildBackhaulConfig(
        baseCfg({ portMap: [{ local: 8080, remote: 443 }, { local: 3000, remote: 80 }] }),
        "server",
      );
      if (out.includes('"443=8080"')) ok("a port map entry renders as remote=local");
      else bad("a port map renders as remote=local", out.split("\n").find((l) => l.startsWith("ports")) ?? "");
      if (out.includes('"80=3000"')) ok("every port map entry is rendered");
      else bad("every port map entry is rendered", "missing an entry");
    }

    // ---------------------------------------------------------------------
    // 7. An empty port map omits the key entirely (no empty list).
    // ---------------------------------------------------------------------
    {
      const out = buildBackhaulConfig(baseCfg({ portMap: [] }), "server");
      if (!out.includes("ports = [")) ok("an empty port map omits the ports key");
      else bad("an empty port map omits the ports key", "emitted an empty list");
    }

    // ---------------------------------------------------------------------
    // 8. Every generated line is a valid TOML key = value assignment.
    //    A stray bare token would be a parse failure on the target node.
    // ---------------------------------------------------------------------
    {
      for (const role of ["server", "client"] as const) {
        const out = buildBackhaulConfig(baseCfg(), role);
        const badLines: string[] = [];
        for (const line of out.split("\n")) {
          if (!line.trim()) continue;
          if (line.startsWith("[")) continue; // section header
          if (!/^[a-z_]+\s*=\s*\S/.test(line)) badLines.push(line);
        }
        if (badLines.length === 0) ok(`every ${role} line is a well-formed TOML assignment`);
        else bad(`every ${role} line is well-formed`, badLines.join(" | "));
      }
    }

    // ---------------------------------------------------------------------
    // 9. A missing client remoteHost falls back rather than emitting "null".
    // ---------------------------------------------------------------------
    {
      const cfg = BackhaulConfigSchema.parse({
        role: "client",
        listenPort: 443,
        token: SECRET_TOKEN,
      });
      const out = buildBackhaulConfig(cfg, "client");
      const line = out.split("\n").find((l) => l.startsWith("remote_addr = ")) ?? "";
      if (!line.includes("undefined") && !line.includes("null")) ok("an absent remoteHost does not leak undefined/null into the config");
      else bad("an absent remoteHost is handled", line);
      if (line.includes("127.0.0.1")) ok("an absent remoteHost falls back to loopback");
      else bad("an absent remoteHost falls back to loopback", line);
    }

    // ---------------------------------------------------------------------
    // 10. The plan must write the token-bearing config 0600.
    //      Asserted against the REAL planner, not a stub, so a regression in
    //      planBackhaul is caught rather than a test-local constant.
    // ---------------------------------------------------------------------
    {
      const { TunnelEngine } = await import("../packages/tunnel-core/src/engine.ts");
      const engine = new TunnelEngine({
        // ctxFor() derives local paths from dataDir, so it must be a real path.
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "xistance-bh-")),
        createProcessHandle: () => ({
          start: async () => undefined,
          stop: async () => undefined,
          dispose: async () => undefined,
          isRunning: async () => false,
          pid: async () => null,
        }),
      } as never);
      const plan = (engine as unknown as {
        planBackhaul(spec: unknown, cfg: BackhaulConfig): Array<{ files: Array<{ path: string; content: string; mode?: number }> }>;
      }).planBackhaul(
        {
          id: "t1",
          name: "t1",
          clientNode: { id: "c1", name: "client", isLocal: true, host: "127.0.0.1" },
          serverNode: { id: "s1", name: "server", isLocal: true, host: "127.0.0.1" },
          dataDir: path.join(os.tmpdir(), "xistance-bh"),
        },
        baseCfg(),
      );
      const files = plan.flatMap((p) => p.files);
      if (files.length === 2) ok(`the plan writes one config per role (${files.length})`);
      else bad("the plan writes one config per role", String(files.length));
      const unmodes = files.filter((f) => (f.mode ?? 0o644) !== 0o600);
      if (unmodes.length === 0) ok("every token-bearing config is written 0600");
      else bad("every token-bearing config is written 0600", `${unmodes.length} file(s) are world-readable`);
    }

    // ---------------------------------------------------------------------
    // 11. The mode reaches the filesystem.
    //
    // Platform note: on Windows, `stat().mode & 0o777` reports 0o666 for every
    // file because NTFS has no POSIX permission bits, so asserting the real
    // file mode here would be a green test measuring nothing. The check is
    // therefore done only where the bits are meaningful, and the planner-side
    // assertion (test 10) is what covers cross-platform intent.
    //
    // A namespace spy is deliberately NOT used: runner.ts captured its `fs`
    // binding at import time, so patching the namespace object after the fact
    // does not intercept the call -- an approach that produced a false
    // `undefined` here rather than a real signal.
    // ---------------------------------------------------------------------
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xistance-mode-"));
      const target = path.join(dir, "config.toml");
      const { LocalRunner } = await import("../packages/tunnel-core/src/runner.ts");
      await new LocalRunner().writeFile(target, `token = "${SECRET_TOKEN}"\n`, 0o600);

      const exists = fs.existsSync(target);
      if (exists) ok("writeFile created the file with the requested mode option");
      else bad("writeFile created the file", "missing");

      if (process.platform === "win32") {
        // NTFS has no POSIX mode bits; a 0600 request is a no-op there and the
        // panel's Linux deployment is where the permission actually matters.
        ok("POSIX mode bits are not meaningful on win32, so the on-disk mode is not asserted here");
      } else {
        const mode = fs.statSync(target).mode & 0o777;
        if (mode === 0o600) ok(`the file on disk is 0600 (got ${mode.toString(8)})`);
        else bad("the file on disk is 0600", `got ${mode.toString(8)}`);
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // ---------------------------------------------------------------------
    // 12. FRP has the same class of config-injection hole.
    //
    //     Found while fixing BACKHAUL: frp.ts had a byte-identical tomlQuote,
    //     and frps.toml/frpc.toml embed an auth token. Mutation testing proved
    //     the BACKHAUL fix alone left FRP unverified, so it is pinned here too.
    // ---------------------------------------------------------------------
    {
      // The real field names, read from buildFrpPair's signature.
      const frpCfg = {
        bindPort: 7000,
        token: SECRET_TOKEN,
        proxies: [] as Array<Record<string, unknown>>,
      };

      const pair = buildFrpPair(frpCfg as never, "tunnel.example.com");
      if (pair.server.includes(SECRET_TOKEN) || pair.client.includes(SECRET_TOKEN)) {
        ok("the FRP configs contain the auth token (it is required)");
      } else {
        bad("the FRP configs contain the auth token", "missing");
      }

      let refused = false;
      let injected = false;
      try {
        const hostile = buildFrpPair(
          { ...frpCfg, token: 'evil\ninjected = "yes' } as never,
          "tunnel.example.com",
        );
        injected = hostile.server.includes("\ninjected = ");
      } catch {
        refused = true;
      }
      if (refused && !injected) ok("a newline in the FRP token is refused, so no TOML key can be injected");
      else if (injected) bad("a newline in the FRP token is refused", "injection succeeded");
      else bad("a newline in the FRP token is refused", "it silently produced output");

      for (const [label, payload] of [["carriage return", "a\rb"], ["NUL", "a\u0000b"]] as const) {
        let okRefused = false;
        try {
          buildFrpPair({ ...frpCfg, token: payload } as never, "tunnel.example.com");
        } catch {
          okRefused = true;
        }
        if (okRefused) ok(`a ${label} in the FRP token is refused`);
        else bad(`a ${label} in the FRP token is refused`, "it was accepted");
      }

      // A normal token must still generate cleanly.
      const clean = buildFrpPair(frpCfg as never, "tunnel.example.com");
      if (clean.server.includes(SECRET_TOKEN) && clean.client.includes(SECRET_TOKEN)) {
        ok("a normal FRP token is unaffected by the guard");
      } else {
        bad("a normal FRP token is unaffected", "the token vanished");
      }
    }

    // ---- TASK-134: the address spliced into bind_addr must be a real address ---
  //
  // `listenAddress` was `z.string()`, and it is interpolated into
  // `bind_addr = "<addr>:<listenPort>"`. An empty one produced `":3080"` -- and
  // backhaul does not reject that. Measured on the target OS with the pinned
  // binary: it binds, listens, and ACCEPTS a client connection. The tunnel
  // reports itself running while the operator's intended address was never
  // honoured, which is the same shape as TASK-131 (GOST) and TASK-133 (SSH).
  {
    const base = {
      role: "server",
      transport: "tcp",
      listenPort: 3080,
      token: "t",
      mux: 8,
      portMap: [],
      listenAddress: "0.0.0.0",
    };
    const hostile: Array<[string, string]> = [
      ["an empty listenAddress", ""],
      ["a URL pasted into listenAddress", "http://evil.example/"],
      ["whitespace inside listenAddress", "0.0.0.0 extra"],
      ["a leading dash in listenAddress", "-oX"],
    ];
    for (const [label, value] of hostile) {
      if (!BackhaulConfigSchema.safeParse({ ...base, listenAddress: value }).success) {
        ok(`the schema rejects ${label} instead of building bind_addr ":PORT"`);
      } else {
        const built = buildBackhaulConfig(
          BackhaulConfigSchema.parse({ ...base, listenAddress: value }) as never,
          "server",
        )
          .split("\n")[1];
        bad(
          `the schema rejects ${label} instead of building bind_addr ":PORT"`,
          `accepted; built ${built}`,
        );
      }
    }
    // remoteHost only matters on the client side, where it is optional and falls
    // back to loopback -- a real address, so it stays optional. But when it IS
    // given it must be an address, not free text.
    const clientBase = {
      role: "client",
      transport: "tcp",
      listenPort: 3080,
      token: "t",
      mux: 8,
      portMap: [],
    };
    if (!BackhaulConfigSchema.safeParse({ ...clientBase, remoteHost: "a/b" }).success) {
      ok("the schema rejects a delimiter in the client's remoteHost");
    } else {
      bad("the schema rejects a delimiter in the client's remoteHost", "it was accepted");
    }
    // Positive control: the loopback fallback must still work, and a real bind
    // must still build unchanged.
    const noRemote = BackhaulConfigSchema.safeParse(clientBase);
    if (noRemote.success) {
      const line = buildBackhaulConfig(noRemote.data as never, "client")
        .split("\n")
        .find((l) => l.startsWith("remote_addr"));
      if (line === 'remote_addr = "127.0.0.1:3080"') {
        ok("a client with no remoteHost still gets the loopback default");
      } else {
        bad("a client with no remoteHost still gets the loopback default", `built ${line}`);
      }
    } else {
      bad(
        "a client with no remoteHost still gets the loopback default",
        "a valid client config was rejected",
      );
    }
    const good = BackhaulConfigSchema.parse(base);
    if (buildBackhaulConfig(good as never, "server").split("\n")[1] === 'bind_addr = "0.0.0.0:3080"') {
      ok("a legitimate server bind still builds bind_addr unchanged");
    } else {
      bad(
        "a legitimate server bind still builds bind_addr unchanged",
        `built ${buildBackhaulConfig(good as never, "server").split("\n")[1]}`,
      );
    }
  }

  console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    /* nothing to clean */
  }
}

void main();
assert.ok(true);
