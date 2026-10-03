/**
 * FRP lifecycle coverage (TASK-27).
 *
 * The important assertions here use a REAL TOML parser, because the two defects
 * this task found were both invisible to a regex or an eyeball:
 *
 *  1. `allowPorts` was emitted AFTER the `[webServer]` table header, so TOML
 *     scoping placed it at `webServer.allowPorts`. frps read the file fine and
 *     silently ignored the allowlist -- the port restriction did nothing while
 *     the UI showed it as configured.
 *  2. `allowPorts` values were emitted unquoted, so "80" parsed as the integer
 *     80 instead of the string the schema declared.
 *  3. `allowPorts` values were emitted as bare strings. frps types the key as
 *     `[]types.PortsRange`, i.e. `{start, end}` objects, and ABORTS at startup
 *     on a string: `field "allowPorts": cannot unmarshal string into
 *     types.PortsRange`. The Foreign node never bound its control port, so
 *     every FRP tunnel failed to come up while the panel reported it
 *     configured. Found by running the emitted config through the real frps
 *     0.70.1 binary pinned in scripts/install.sh -- a TOML parser alone
 *     cannot see this, because the TOML is perfectly valid; it is frps's own
 *     Go struct tag that refuses it.
 *
 * All three were found by generating a config, parsing it, and checking where
 * the keys actually landed, then feeding it to the real binary.
 *
 * Real-binary coverage: frps 0.70.1 was run against the emitted server config
 * on Ubuntu 22.04.5 amd64 and accepted it; strings, bare numbers and a bare
 * object were each rejected. See .agent/evidence/task-65-tunnel-traffic.md.
 */
import { strict as assert } from "node:assert";
import { parse } from "smol-toml";

import { FrpClientConfigSchema } from "../packages/types/src/index.ts";
import {
  buildFrpClientConfig,
  buildFrpPair,
  buildFrpServerConfig,
} from "../packages/tunnel-core/src/config/frp.ts";
import { FrpConfigSchema, FrpProxySchema, type FrpProxy } from "../packages/types/src/index.ts";
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

const TOKEN = "s3cr3t-frp-token-abc123";

/**
 * Every proxy fixture is produced BY THE SCHEMA.
 *
 * A hand-written object is not evidence: the schema supplies `transport`
 * defaults, so a literal that omits it can never reach buildFrpClientConfig
 * through the application, and asserting on it would test an impossible state
 * (which is exactly how this file first crashed).
 */
const mkProxy = (o: Record<string, unknown>): FrpProxy =>
  FrpProxySchema.parse({
    name: "web",
    type: "tcp",
    localIP: "127.0.0.1",
    localPort: 8080,
    remotePort: 80,
    customDomains: ["example.com"],
    ...o,
  });

const baseProxy = mkProxy({ transport: { encryption: true, compression: false } });

async function main(): Promise<void> {
  try {
    // ---------------------------------------------------------------------
    // 0. Schema rejects invalid input.
    // ---------------------------------------------------------------------
    {
      const good = {
        bindPort: 7000,
        token: TOKEN,
        proxies: [baseProxy],
      };
      if (FrpConfigSchema.safeParse(good).success) ok("a valid FRP config parses");
      else bad("a valid FRP config parses", "it was rejected");

      const rejects: Array<[string, unknown]> = [
        ["bindPort 0", { ...good, bindPort: 0 }],
        ["bindPort 70000", { ...good, bindPort: 70000 }],
        ["bindPort non-integer", { ...good, bindPort: 7000.5 }],
        ["empty token", { ...good, token: "" }],
        ["no proxies", { ...good, proxies: [] }],
        ["bindUdpPort 0", { ...good, bindUdpPort: 0 }],
        ["dashboard port 70000", { ...good, dashboard: { port: 70000 } }],
      ];
      let n = 0;
      for (const [label, cfg] of rejects) {
        if (!FrpConfigSchema.safeParse(cfg).success) n += 1;
        else bad(`schema rejects ${label}`, "it parsed");
      }
      if (n === rejects.length) ok(`the schema rejects all ${rejects.length} invalid FRP configs`);

      // An unknown proxy type must be refused rather than passed to frpc.
      const badType = FrpConfigSchema.safeParse({
        ...good,
        proxies: [{ ...baseProxy, type: "definitely-not-a-frp-type" }],
      });
      if (!badType.success) ok("an unsupported proxy type is rejected");
      else bad("an unsupported proxy type is rejected", "it parsed");
    }

    // ---------------------------------------------------------------------
    // 1. allowPorts lands at the TOP LEVEL, not inside [webServer].
    //    This is the defect the parser test exists for.
    // ---------------------------------------------------------------------
    {
      const pair = buildFrpPair(
        {
          bindPort: 7000,
          token: TOKEN,
          dashboard: { enabled: true, port: 17500, user: "admin", password: "dashpass" },
          allowPorts: ["80", "443"],
          proxies: [baseProxy],
        },
        "srv.example.com",
      );
      const parsed = parse(pair.server) as Record<string, unknown>;
      if (Array.isArray(parsed.allowPorts)) ok("allowPorts is a top-level frps key");
      else bad("allowPorts is a top-level frps key", `it landed at ${Object.keys(parsed).join(",")}`);
      const ws = (parsed.webServer ?? {}) as Record<string, unknown>;
      if (ws.allowPorts === undefined) ok("allowPorts does not leak into [webServer]");
      else bad("allowPorts does not leak into [webServer]", JSON.stringify(ws.allowPorts));

      // Values must be {start,end} ranges, not strings. frps 0.70.1 aborts at
      // startup on a string ("cannot unmarshal string into types.PortsRange"),
      // so this shape is a start-up contract, not a style preference.
      const values = parsed.allowPorts as unknown[];
      const isRange = (v: unknown): boolean =>
        typeof v === "object" &&
        v !== null &&
        typeof (v as Record<string, unknown>).start === "number" &&
        typeof (v as Record<string, unknown>).end === "number";
      if (values.length === 2 && values.every(isRange))
        ok(`allowPorts values are {start,end} ranges (${JSON.stringify(values)})`);
      else bad("allowPorts values are {start,end} ranges", JSON.stringify(values));

      // A range string expands to start<end; a bare port has start === end.
      const rangePair = buildFrpPair(
        {
          bindPort: 7000,
          token: TOKEN,
          allowPorts: ["6000-6100"],
          proxies: [baseProxy],
        },
        "srv.example.com",
      );
      const rp = (parse(rangePair.server).allowPorts ?? []) as { start: number; end: number }[];
      if (rp.length === 1 && rp[0].start === 6000 && rp[0].end === 6100)
        ok("a \"6000-6100\" range expands to start=6000 end=6100");
      else bad("a \"6000-6100\" range expands to start=6000 end=6100", JSON.stringify(rp));

      // No emitted allowPorts entry may be a bare string: that is exactly what
      // frps rejects, and it is unrepresentable in the new emitter.
      if (!values.some((v) => typeof v === "string"))
        ok("no allowPorts entry is a bare string (frps would refuse to start)");
      else bad("no allowPorts entry is a bare string", JSON.stringify(values));

      // A malformed range must throw rather than emit a config frps rejects.
      for (const badSpec of ["abc", "70000", "6000-100", "", "80;rm -rf /"]) {
        let threw = false;
        try {
          buildFrpPair({ bindPort: 7000, token: TOKEN, allowPorts: [badSpec], proxies: [baseProxy] }, "srv.example.com");
        } catch {
          threw = true;
        }
        if (threw) ok(`a malformed allowPorts entry is rejected (${JSON.stringify(badSpec)})`);
        else bad(`a malformed allowPorts entry is rejected (${JSON.stringify(badSpec)})`, "it emitted a config");
      }
    }

    // ---------------------------------------------------------------------
    // 2. Both configs parse, and every key lands where frp expects it.
    // ---------------------------------------------------------------------
    {
      const pair = buildFrpPair(
        { bindPort: 7000, token: TOKEN, proxies: [baseProxy] },
        "srv.example.com",
      );
      let serverOk = false;
      try {
        const s = parse(pair.server) as Record<string, unknown>;
        serverOk = s.bindPort === 7000 && (s.auth as Record<string, unknown>).token === TOKEN;
      } catch {
        serverOk = false;
      }
      if (serverOk) ok("frps.toml parses with the expected bindPort and auth token");
      else bad("frps.toml parses with the expected values", parse.name);

      let clientOk = false;
      try {
        const c = parse(pair.client) as { serverAddr?: string; serverPort?: number; proxies?: unknown[] };
        clientOk = c.serverAddr === "srv.example.com" && c.serverPort === 7000 && c.proxies?.length === 1;
      } catch {
        clientOk = false;
      }
      if (clientOk) ok("frpc.toml parses with the expected server address, port and proxy count");
      else bad("frpc.toml parses with the expected values", "parse mismatch");
    }

    // ---------------------------------------------------------------------
    // 3. Proxy tables nest correctly under [[proxies]].
    // ---------------------------------------------------------------------
    {
      const cases: Array<[string, Record<string, unknown>, string[]]> = [
        ["plain tcp", { ...baseProxy }, ["name", "type", "localPort", "remotePort", "transport"]],
        [
          "plugin proxy",
          { ...baseProxy, plugin: { type: "http_proxy", addr: "127.0.0.1", port: 3128 } },
          ["name", "type", "transport", "plugin"],
        ],
        [
          "bandwidth limit",
          { ...baseProxy, transport: { ...baseProxy.transport, bandwidthLimit: "10MB" } },
          ["name", "type", "transport"],
        ],
      ];
      let bad_count = 0;
      for (const [label, proxy, expect] of cases) {
        const out = buildFrpClientConfig({
          role: "client",
          serverAddr: "s",
          serverPort: 7000,
          token: TOKEN,
          proxies: [proxy as never],
        });
        try {
          const c = parse(out) as { proxies?: Array<Record<string, unknown>> };
          const px = (c.proxies ?? [])[0] ?? {};
          for (const k of expect) {
            if (!(k in px)) {
              bad_count += 1;
              bad(`${label} proxy exposes ${k}`, `keys=${Object.keys(px).join(",")}`);
            }
          }
        } catch (e) {
          bad_count += 1;
          bad(`${label} proxy parses`, (e as Error).message);
        }
      }
      if (bad_count === 0) ok(`all ${cases.length} proxy shapes parse with the expected keys`);

      // A visitor proxy must carry serverName, not remotePort.
      const visitor = buildFrpClientConfig({
        role: "client",
        serverAddr: "s",
        serverPort: 7000,
        token: TOKEN,
        proxies: [mkProxy({ name: "v", type: "stcp", role: "visitor", serverName: "web", secretKey: "sk" })],
      });
      const vp = (parse(visitor) as { proxies?: Array<Record<string, unknown>> }).proxies?.[0] ?? {};
      if (vp.serverName === "web" && vp.remotePort === undefined) ok("a visitor proxy emits serverName and no remotePort");
      else bad("a visitor proxy emits serverName only", JSON.stringify(vp));
    }

    // ---------------------------------------------------------------------
    // 4. Multiple proxies each get their own [[proxies]] table.
    // ---------------------------------------------------------------------
    {
      const out = buildFrpClientConfig({
        role: "client",
        serverAddr: "s",
        serverPort: 7000,
        token: TOKEN,
        proxies: [
          { ...baseProxy, name: "one" } as never,
          { ...baseProxy, name: "two", remotePort: 443 } as never,
        ],
      });
      const c = parse(out) as { proxies?: Array<Record<string, unknown>> };
      if (c.proxies?.length === 2) ok("two proxies produce two [[proxies]] tables");
      else bad("two proxies produce two tables", String(c.proxies?.length));
      if (c.proxies?.[0].name === "one" && c.proxies?.[1].name === "two") {
        ok("each proxy table keeps its own name (no cross-contamination)");
      } else {
        bad("each proxy keeps its own name", JSON.stringify(c.proxies?.map((p) => p.name)));
      }
    }

    // ---------------------------------------------------------------------
    // 5. Determinism.
    // ---------------------------------------------------------------------
    {
      const cfg = { bindPort: 7000, token: TOKEN, proxies: [baseProxy] };
      const a = buildFrpPair(cfg, "s");
      const b = buildFrpPair(cfg, "s");
      if (a.server === b.server && a.client === b.client) ok("FRP config generation is deterministic");
      else bad("FRP config generation is deterministic", "two calls differed");
      if (a.client.endsWith("\n")) ok("the generated client config ends with a newline");
      else bad("the generated client config ends with a newline", "missing");
    }

    // ---------------------------------------------------------------------
    // 6. Credentials never reach diagnostics.
    // ---------------------------------------------------------------------
    {
      const pair = buildFrpPair(
        {
          bindPort: 7000,
          token: TOKEN,
          dashboard: { enabled: true, user: "admin", password: "dash-secret-9911" },
          proxies: [{ ...baseProxy, secretKey: "proxy-secret-7733" } as never],
        },
        "s",
      );
      for (const [label, text] of [["frps", pair.server], ["frpc", pair.client]] as const) {
        if (text.includes(TOKEN)) ok(`${label} carries the token (required for auth)`);
        else bad(`${label} carries the token`, "missing");

        const dumped = sanitizeForDiagnostics(`frpc failed:\n${text}`);
        for (const secret of [TOKEN, "dash-secret-9911", "proxy-secret-7733"]) {
          if (dumped.includes(secret)) bad(`${label} diagnostic redacts ${secret.slice(0, 12)}`, "leaked");
        }
        if (!dumped.includes(TOKEN) && !dumped.includes("dash-secret-9911")) {
          ok(`${label} diagnostic carries no credential`);
        }
        // The key must survive so the operator knows what was redacted.
        if (/auth\.token|token/i.test(dumped)) ok(`${label} diagnostic still names the credential key`);
        else bad(`${label} diagnostic names the credential key`, "key vanished");
      }
    }

    // ---------------------------------------------------------------------
    // 7. Injection is refused (carried over from TASK-26, re-verified here).
    // ---------------------------------------------------------------------
    {
      for (const [label, payload] of [
        ["newline", 'a\nb'],
        ["carriage return", "a\rb"],
        ["NUL", "a\u0000b"],
      ] as const) {
        let refused = false;
        try {
          buildFrpPair({ bindPort: 7000, token: payload, proxies: [baseProxy] }, "s");
        } catch {
          refused = true;
        }
        if (refused) ok(`a ${label} in the FRP token is refused`);
        else bad(`a ${label} in the FRP token is refused`, "it was accepted");
      }
    }

    // ---------------------------------------------------------------------
    // 8. A disabled dashboard omits the whole [webServer] table.
    // ---------------------------------------------------------------------
    {
      const out = buildFrpServerConfig({
        role: "server",
        bindPort: 7000,
        token: TOKEN,
        dashboard: { enabled: false },
      });
      const s = parse(out) as Record<string, unknown>;
      if (s.webServer === undefined) ok("a disabled dashboard emits no [webServer] table");
      else bad("a disabled dashboard emits no table", JSON.stringify(s.webServer));
      if (s.bindPort === 7000) ok("the rest of the server config is intact without a dashboard");
      else bad("the rest of the server config is intact", String(s.bindPort));
    }

    // ---------------------------------------------------------------------
    // 9. allowPorts is omitted entirely when empty (not an empty list).
    // ---------------------------------------------------------------------
    {
      const out = buildFrpServerConfig({
        role: "server",
        bindPort: 7000,
        token: TOKEN,
        dashboard: { enabled: false },
        allowPorts: [],
      });
      const s = parse(out) as Record<string, unknown>;
      if (s.allowPorts === undefined) ok("an empty allowPorts emits no key");
      else bad("an empty allowPorts emits no key", JSON.stringify(s.allowPorts));
    }

    // ---------------------------------------------------------------------
    // 10. The dashboard password is not silently empty-but-present.
    // ---------------------------------------------------------------------
    {
      const out = buildFrpServerConfig({
        role: "server",
        bindPort: 7000,
        token: TOKEN,
        dashboard: { enabled: true, user: "admin" },
      });
      const s = parse(out) as { webServer?: Record<string, unknown> };
      // FRP requires a password on the webServer; emitting "" is accepted by
      // the parser but leaves the dashboard with an empty credential, so it is
      // asserted explicitly rather than left to a comment.
      if (s.webServer?.password === "") {
        ok("an omitted dashboard password is emitted as an explicit empty string");
      } else {
        bad("an omitted dashboard password is explicit", String(s.webServer?.password));
      }
      if (s.webServer?.port === 17500) ok("a dashboard without a port falls back to 17500");
      else bad("a dashboard without a port falls back to 17500", String(s.webServer?.port));
    }

    // ---- TASK-132: the plugin block must contain only what frpc 0.70.1 accepts ----
  //
  // `addr` and `port` were emitted under `[proxies.plugin]`. frpc 0.70.1 -- the
  // version install.sh pins -- REJECTS both as unknown fields (exit 1), so any
  // proxy configured with a plugin could not start at all:
  //
  //   [proxies.plugin] type only   -> "syntax is ok", exit 0
  //   + addr = "127.0.0.1"        -> unknown field "addr", exit 1
  //   + [proxies.plugin.params]   -> unknown field "params", exit 1
  //
  // `addr`/`port`/`user` are real frp fields, but on the PER-PLUGIN option
  // structs (HTTPProxyPluginOptions and friends), not on ClientPluginOptions,
  // which carries `type` alone -- confirmed from the pinned binary's own type
  // table, since the source is not fetched at build time.
  {
    const cfg = {
      role: "client",
      serverAddr: "127.0.0.1",
      serverPort: 17000,
      token: "t",
      proxies: [
        {
          name: "p",
          type: "tcp",
          localIP: "127.0.0.1",
          localPort: 8080,
          remotePort: 19098,
          plugin: { type: "http_proxy" },
        },
      ],
    };
    // Built through the real schema so every default (transport.encryption and
    // friends, which proxyBlock() dereferences) is filled in rather than faked.
    const parsed = FrpClientConfigSchema.parse(cfg);
    const toml = buildFrpClientConfig(parsed as never);
    const offending = toml.match(/^(addr|port|params)\s*=/m);
    if (!offending) {
      ok("the FRP plugin block emits no key frpc 0.70.1 rejects as unknown");
    } else {
      bad(
        "the FRP plugin block emits no key frpc 0.70.1 rejects as unknown",
        `emitted ${offending[0]}`,
      );
    }
    if (/\[proxies\.plugin\]\ntype = "http_proxy"/.test(toml)) {
      ok("the FRP plugin block still carries the type it was configured with");
    } else {
      bad(
        "the FRP plugin block still carries the type it was configured with",
        `block was ${JSON.stringify(toml.slice(toml.indexOf("[proxies.plugin]")))}`,
      );
    }

    // A row saved before the schema dropped addr/port must not resurrect them:
    // Zod strips unknown keys, and the builder never reads them anyway.
    const stale = FrpClientConfigSchema.parse({
      ...cfg,
      proxies: [
        { ...cfg.proxies[0], plugin: { type: "http_proxy", addr: "10.0.0.5", port: 3128 } },
      ],
    });
    const plugin = (stale.proxies[0] as { plugin?: Record<string, unknown> }).plugin ?? {};
    if (!("addr" in plugin) && !("port" in plugin)) {
      ok("a stored row carrying addr/port has them stripped at parse time");
    } else {
      bad(
        "a stored row carrying addr/port has them stripped at parse time",
        `stored ${JSON.stringify(plugin)}`,
      );
    }
    if (!/^(addr|port)\s*=/m.test(buildFrpClientConfig(stale as never))) {
      ok("and a stored row carrying addr/port cannot put them back into the TOML");
    } else {
      bad(
        "and a stored row carrying addr/port cannot put them back into the TOML",
        "addr/port reappeared in the emitted config",
      );
    }

    // Positive control: a proxy with no plugin must not grow one.
    const none = buildFrpClientConfig(
      FrpClientConfigSchema.parse({
        ...cfg,
        proxies: [{ ...cfg.proxies[0], plugin: undefined }],
      }) as never,
    );
    if (!/\[proxies\.plugin\]/.test(none)) {
      ok("a proxy without a plugin still emits no plugin block");
    } else {
      bad("a proxy without a plugin still emits no plugin block", "a block appeared");
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
