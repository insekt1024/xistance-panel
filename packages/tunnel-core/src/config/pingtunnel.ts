import type { IcmpConfig } from "@xistance/types";

// ---------------------------------------------------------------------------
// ICMP tunnel — pingtunnel (https://github.com/esrrhs/pingtunnel).
//
// Model: the FOREIGN node runs `pingtunnel -type server` and needs raw ICMP
// (root / CAP_NET_RAW). The IRAN node runs `pingtunnel -type client -l :PORT -s
// <server host> -t <target>` and carries the traffic inside ICMP echo packets,
// so it works when everything except ping is filtered.
//
// Why the key never appears in argv:
//   `-key` and `-encrypt-key` are both secrets shared by the two nodes. argv is
//   world-readable through `ps` on a shared host, and the systemd unit text the
//   engine writes to disk is too. Both go into a JSON config file passed with
//   `-c` and written 0600 — the same reason BACKHAUL's config.toml is 0600
//   because it embeds the shared token.
// ---------------------------------------------------------------------------

export const PINGTUNNEL_BINARY = "pingtunnel";

/** JSON keys, verbatim from pingtunnel's USAGE.md config-file mode. */
type ServerConfigJson = {
  type: "server";
  key: number;
  icmp_listen: string;
  maxconn: number;
  encrypt?: string;
  encrypt_key?: string;
};

type ClientConfigJson = {
  type: "client";
  key: number;
  listen: string;
  server: string;
  target?: string;
  tcp?: number;
  sock5?: number;
  timeout: number;
  encrypt?: string;
  encrypt_key?: string;
};

/**
 * Reject a host that would break out of the JSON string or the `-s` token.
 *
 * The schema already narrows this with `hostLikeAddress`, but a builder that
 * trusts its input is how argv injection reaches systemd: `sanitizeUnitText`
 * and `shellQuote` are the last line, not the first. Same defence-in-depth
 * shape DIRECT and GOST use.
 */
function assertSafeHost(value: string, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`ICMP ${field} must not be empty`);
  }
  if (value !== value.trim()) {
    throw new Error(`ICMP ${field} must not have leading or trailing whitespace`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f"\\]/.test(value)) {
    throw new Error(
      `ICMP ${field} must not contain whitespace, quotes, backslashes or control characters`,
    );
  }
  if (value.startsWith("-")) {
    throw new Error(`ICMP ${field} must not start with '-': it would be parsed as an option`);
  }
}

/**
 * Server config file contents.
 *
 * `key` is emitted as a JSON NUMBER because USAGE.md types it as a number and
 * pingtunnel parses it as one; emitting a string would make `-key "123456"`
 * compare unequal to a numeric 123456 in some Go paths and, at worst, silently
 * read as zero.
 */
export function buildIcmpServerConfig(cfg: IcmpConfig): string {
  assertSafeHost(cfg.icmpListen, "icmpListen");
  const doc: ServerConfigJson = {
    type: "server",
    key: cfg.key,
    icmp_listen: cfg.icmpListen,
    maxconn: cfg.maxConn,
  };
  if (cfg.encryption !== "none") {
    doc.encrypt = cfg.encryption;
    doc.encrypt_key = cfg.encryptionKey;
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Client config file contents.
 *
 * `serverHost` is the peer node's host, passed by the planner: the panel knows
 * the node inventory, the config does not, and duplicating it would let the two
 * disagree silently.
 */
export function buildIcmpClientConfig(cfg: IcmpConfig, serverHost: string): string {
  assertSafeHost(serverHost, "server host");
  assertSafeHost(cfg.listenAddr, "listenAddr");
  const doc: ClientConfigJson = {
    type: "client",
    key: cfg.key,
    listen: cfg.listenAddr,
    server: serverHost,
    timeout: cfg.timeoutSecs,
  };
  if (cfg.sock5) {
    doc.sock5 = 1;
    // SOCKS5 is a TCP control protocol, and upstream USAGE.md says -sock5 1
    // "automatically enables TCP", so set it explicitly rather than relying on
    // that. Measured: with `tcp` omitted, pingtunnel 2.10 STILL served a SOCKS5
    // request over TCP (scripts/test-real-icmp-modes.sh), so this line is
    // belt-and-braces rather than a fix for an observed failure. It is asserted
    // anyway, so a future upstream that honours Tcpmode strictly cannot silently
    // put a SOCKS5 tunnel on the datagram path.
    doc.tcp = 1;
  } else {
    // Refuse a half-pair here too. The schema forbids it, but emitting
    // `target: ":0"` would make pingtunnel start and refuse every connection,
    // reporting a running tunnel that carries nothing — the exact failure GOST
    // shipped once.
    if (!cfg.targetHost || !cfg.targetPort) {
      throw new Error(
        `ICMP needs a complete forward target: got targetHost=${JSON.stringify(cfg.targetHost)}, ` +
          `targetPort=${JSON.stringify(cfg.targetPort)}`,
      );
    }
    assertSafeHost(cfg.targetHost, "targetHost");
    doc.target = `${cfg.targetHost}:${cfg.targetPort}`;
    // Upstream selects the transport from ONE flag: server.go dials "tcp" when
    // Tcpmode > 0 and "udp" otherwise, so `-tcp 0` is how UDP is requested --
    // there is no separate -udp flag. SOCKS5 needs tcp=1 as well, because
    // SOCKS5 is a TCP control protocol (upstream USAGE.md: "automatically
    // enables TCP"). So: SOCKS5 -> TCP, else the caller's choice.
    doc.tcp = cfg.sock5 || cfg.protocol === "tcp" ? 1 : 0;
  }
  if (cfg.encryption !== "none") {
    doc.encrypt = cfg.encryption;
    doc.encrypt_key = cfg.encryptionKey;
  }
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * The argv for either role. Identical in shape: the binary plus `-c <path>`.
 *
 * Everything else lives in the file, so this function cannot leak the key and
 * there is no second place to forget the 0600 mode.
 */
export function buildIcmpCommand(configPath: string): string[] {
  if (typeof configPath !== "string" || configPath.trim() === "") {
    throw new Error("ICMP config path must not be empty");
  }
  if (/[\s\u0000-\u001f\u007f]/.test(configPath)) {
    throw new Error("ICMP config path must not contain whitespace or control characters");
  }
  return [PINGTUNNEL_BINARY, "-c", configPath];
}

/** Filename for one role's config, under that node's cfgDir. */
export function icmpConfigFileName(tunnelId: string, role: "server" | "client"): string {
  const safe = tunnelId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
  return `pingtunnel-${safe}-${role}.json`;
}
