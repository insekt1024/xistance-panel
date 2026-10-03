/**
 * Generate real tunnel configs for the target-OS traffic harness, using the
 * PRODUCT'S OWN builders.
 *
 * TASK-126 found that 7 of 8 traffic claims in `real-binary-evidence.json` rest on
 * probes that cannot be re-run: they lived in `/tmp` on containers that no longer
 * exist, and no test in the repo starts a binary and moves bytes for them.
 *
 * A hand-written replica proves the replica (TASK-124 burned five attempts on one
 * for XRAY). So every config here comes from the same builder the panel calls, after
 * parsing the input through the real Zod schema FIRST -- the artifact under test is
 * then byte-identical to the shipped one, and a wrong field name fails HERE instead
 * of producing a config the binary silently rejects. (The first draft used
 * `as never` casts and died inside `tomlQuote` on an undefined value; the schemas
 * are the guard against exactly that.)
 *
 * Usage: npx tsx scripts/gen-traffic-fixtures.ts <output-dir>
 * Prints one JSON line per method describing what it wrote.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  BackhaulConfigSchema,
  FrpServerConfigSchema,
  FrpClientConfigSchema,
  GostConfigSchema,
  DirectConfigSchema,
  SshConfigSchema,
  ReverseConfigSchema,
} from "../packages/types/src/index.ts";
import { buildBackhaulConfig } from "../packages/tunnel-core/src/config/backhaul.ts";
import { buildFrpServerConfig, buildFrpClientConfig } from "../packages/tunnel-core/src/config/frp.ts";
import { buildGostCommand } from "../packages/tunnel-core/src/config/gost.ts";
import { buildDirectCommand } from "../packages/tunnel-core/src/config/direct.ts";
import { buildXrayConfig } from "../packages/tunnel-core/src/config/xray.ts";
import { buildSshCommand } from "../packages/tunnel-core/src/config/ssh.ts";
import { reverseToSshConfig } from "../packages/tunnel-core/src/config/reverse.ts";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: npx tsx scripts/gen-traffic-fixtures.ts <output-dir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const written: Record<string, string[]> = {};
const emit = (method: string, file: string, body: string): void => {
  writeFileSync(path.join(outDir, file), body);
  (written[method] ??= []).push(file);
};

// Ports are the harness's; the target side is 19098 and the origin answers
// HELLO-XR. Every value here is a throwaway fixture -- no credential, no secret.
const ORIGIN_PORT = 19098;

// ---------------------------------------------------------------- BACKHAUL ---
{
  const token = randomUUID();

  // The engine passes ONE config object to BOTH roles:
  //   buildBackhaulConfig(c, "server")  and  buildBackhaulConfig(c, "client")
  // and for role="client" it emits `remote_addr = "${remoteHost}:${listenPort}"`.
  //
  // So `listenPort` must be the SAME on both: for the client it is the port it
  // DIALS (the server's), and for the server it is the port it BINDS. My first
  // fixture gave them different ports, so the client dialled 127.0.0.1:19002,
  // nothing listened there, and backhaul logged
  //   [ERROR] channel dialer: dial tcp <nil>->127.0.0.1:19002: connection refused
  //
  // `remoteHost` is what makes it work locally: in production the client is on a
  // different node and its remoteHost is the server's address; here both run on
  // one host, so 127.0.0.1 is correct.
  const pair = BackhaulConfigSchema.parse({
    role: "client",
    transport: "tcp",
    listenAddress: "127.0.0.1",
    listenPort: 19001,
    remoteHost: "127.0.0.1",
    token,
  });

  // portsBlock() emits `ports = ["<remote>=<local>"]`: `remote` is the port the
  // SERVER exposes, `local` is where it forwards. So remote must be the probe
  // port and local the origin's.
  const server = BackhaulConfigSchema.parse({ ...pair, role: "server" });
  server.portMap = [{ local: ORIGIN_PORT, remote: 18101 }];

  emit("BACKHAUL", "backhaul-server.json", buildBackhaulConfig(server, "server"));
  emit("BACKHAUL", "backhaul-client.json", buildBackhaulConfig(pair, "client"));
}

// --------------------------------------------------------------------- FRP ---
{
  const token = randomUUID();
  const server = FrpServerConfigSchema.parse({
    role: "server",
    bindPort: 17000,
    token,
    // Plain strings, per the schema. TASK-65 found frps rejects `[{start,end}]`
    // objects here, and then no FRP tunnel binds its control port at all.
    allowPorts: ["18100-18199"],
  });
  const client = FrpClientConfigSchema.parse({
    role: "client",
    serverAddr: "127.0.0.1",
    serverPort: 17000,
    token,
    proxies: [
      {
        name: "probe",
        type: "tcp",
        localIP: "127.0.0.1",
        localPort: ORIGIN_PORT,
        remotePort: 18100,
      },
    ],
  });
  emit("FRP", "frps.toml", buildFrpServerConfig(server));
  emit("FRP", "frpc.toml", buildFrpClientConfig(client));
}

// ------------------------------------------------------------- GOST/DIRECT ---
{
  const gost = GostConfigSchema.parse({
    direction: "IRAN",
    protocol: "tcp",
    listenPort: 18102,
    forwardHost: "127.0.0.1",
    forwardPort: ORIGIN_PORT,
  });
  // buildGostCommand(cfg, role) returns null when cfg.direction !== role: a
  // one-directional GOST tunnel is only built for the listening side. Passing no
  // role produced `null` and a config file containing the text "null".
  const gostArgv = buildGostCommand(gost, "IRAN");
  if (!gostArgv) throw new Error("buildGostCommand returned null for direction=IRAN");
  emit("GOST", "gost-argv.json", JSON.stringify(gostArgv));

  const direct = DirectConfigSchema.parse({
    protocol: "tcp",
    bindAddr: "127.0.0.1",
    listenPort: 18103,
    targetHost: "127.0.0.1",
    targetPort: ORIGIN_PORT,
  });
  const directArgv = buildDirectCommand(direct);
  if (!directArgv || directArgv.length === 0) throw new Error("buildDirectCommand returned nothing");
  emit("DIRECT", "direct-argv.json", JSON.stringify(directArgv));
}

// -------------------------------------------------------------- SSH/REVERSE ---
// Both need a live sshd, which the target OS already has. The harness generates a
// throwaway keypair in the target's own authorized_keys, so no credential from the
// repo or the environment is involved: a random key created here, used here.
const KEY = "/root/.ssh/id_ed25519_traffic";
{
  // SSH, mode "local": expose the origin on 127.0.0.1:18104 -> remoteHost:remotePort.
  const ssh = SshConfigSchema.parse({
    mode: "local",
    host: "127.0.0.1",
    port: 22,
    username: "root",
    auth: "key",
    localBindAddr: "127.0.0.1",
    localPort: 18104,
    remoteHost: "127.0.0.1",
    remotePort: ORIGIN_PORT,
    useAutossh: false,
  });
  emit("SSH", "ssh-argv.json", JSON.stringify(buildSshCommand(ssh, { keyPath: KEY })));

  // REVERSE is not a separate builder: engine.ts maps it with reverseToSshConfig
  // and runs the resulting ssh argv. Generating it through THAT mapping is what
  // proves REVERSE, rather than hand-writing a second argv that could drift.
  const reverse = ReverseConfigSchema.parse({
    protocol: "tcp",
    listenPort: 18106,
    forwardHost: "127.0.0.1",
    forwardPort: ORIGIN_PORT,
    host: "127.0.0.1",
    port: 22,
    username: "root",
    auth: "key",
    useAutossh: false,
  });
  const asSsh = reverseToSshConfig(reverse, "127.0.0.1");
  emit("REVERSE", "reverse-argv.json", JSON.stringify(buildSshCommand(asSsh, { keyPath: KEY })));
}

// --------------------------------------------------------------------- XRAY ---
// The product writes the CLIENT config; the panel expects a 3X-UI panel to provide
// the vmess/VLESS inbound. That inbound is three lines of xray config that no product
// builder exists for, so it is written here from the SAME uuid as the client -- which
// is the only coupling between them. Hand-writing the CLIENT is what TASK-124 burned
// five attempts on, so that half still comes from buildXrayConfig().
{
  const uuid = randomUUID();
  emit(
    "XRAY",
    "xray-client.json",
    buildXrayConfig({
      listenPort: 18105,
      protocol: "vmess",
      address: "127.0.0.1",
      port: 19083,
      uuid,
      network: "tcp",
      security: "none",
    }),
  );
  emit(
    "XRAY",
    "xray-server.json",
    JSON.stringify({
      log: { loglevel: "warning" },
      inbounds: [
        {
          tag: "xistance-in",
          port: 19083,
          listen: "127.0.0.1",
          protocol: "vmess",
          settings: { clients: [{ id: uuid }] },
          streamSettings: { network: "tcp" },
        },
      ],
      outbounds: [{ tag: "direct", protocol: "freedom" }],
    }),
  );
}

console.log(JSON.stringify(written, null, 2));