/**
 * Generate the XRAY test config with the PRODUCT'S OWN builder.
 *
 * TASK-124 spent five attempts hand-writing an xray config and failing: a `socks`
 * inbound instead of `dokodemo-door`, no `sniffing`, no `freedom` outbound, no
 * routing rule. Each of those is a difference from what the panel actually writes,
 * so the test was measuring a config the product never produces.
 *
 * This calls `buildXrayConfig()` itself, after parsing the input through the real
 * `XrayConfigSchema`, so the client config is byte-identical to the shipped one. Only
 * the far-end vmess INBOUND is written here: the product expects a 3X-UI panel to
 * provide that side and has no builder for it.
 *
 * Usage: npx tsx scripts/gen-xray-test-config.ts <output-dir> [uuid]
 * Prints the uuid it used, so the caller can pair the two halves.
 */
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildXrayConfig } from "../packages/tunnel-core/src/config/xray.ts";
import { XrayConfigSchema } from "../packages/types/src/index.ts";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: npx tsx scripts/gen-xray-test-config.ts <output-dir> [uuid]");
  process.exit(2);
}
const uuid = process.argv[3] || randomUUID();

// Parse through the REAL schema, so an invalid field is rejected here rather than
// by xray on the target with a message nobody reads.
const client = XrayConfigSchema.parse({
  listenPort: 18082,
  protocol: "vmess",
  address: "127.0.0.1",
  port: 19083,
  uuid,
  network: "tcp",
  security: "none",
});
writeFileSync(path.join(outDir, "xray-client.json"), buildXrayConfig(client));

// The 3X-UI side: a vmess inbound that releases to freedom.
writeFileSync(
  path.join(outDir, "xray-server.json"),
  JSON.stringify(
    {
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
    },
    null,
    2,
  ) + "\n",
);

console.log(uuid);