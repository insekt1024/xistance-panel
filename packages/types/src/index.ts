import { z } from "zod";

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

/**
 * A bare network address, as it may appear inside a concatenated URL or ssh
 * forward argument: a hostname, IPv4 literal, or IPv6 literal.
 *
 * Shared by DIRECT (`bindAddr`/`targetHost`) and REVERSE (`forwardHost`/
 * `remoteBindAddr`), because both are spliced into a single delimited string
 * where a "/", a space or a leading "-" silently changes the meaning.
 */
const hostLikeAddress = z
  .string()
  .min(1)
  .refine((v) => v.trim() === v, "must not have leading or trailing whitespace")
  .refine((v) => !/[\s\u0000-\u001f\u007f]/.test(v), "must not contain whitespace or control characters")
  // Scheme FIRST, for the same reason as the builder's check: "tcp://host"
  // contains "/" and would otherwise be reported as a delimiter problem, which
  // is technically true but tells the operator nothing about what to change.
  .refine((v) => !v.includes("://"), "must be a bare address, without a scheme")
  .refine((v) => !/[/\\?#@]/.test(v), "must not contain a URL delimiter (/ \\ ? # @)")
  .refine((v) => !v.startsWith("-"), "must not start with '-'")
  .refine(
    (v) => {
      // IPv6 literal first, optionally with a zone id. A colon is the
      // discriminator: no hostname or IPv4 literal contains one, and the
      // hostname pattern below would reject every IPv6 address.
      if (v.includes(":")) return /^[0-9A-Fa-f:.]+(?:%[A-Za-z0-9._~-]+)?$/.test(v);
      return /^[A-Za-z0-9_][A-Za-z0-9_-]*(\.[A-Za-z0-9_][A-Za-z0-9_-]*)*$/.test(v);
    },
    "must be a hostname, IPv4 or IPv6 literal",
  );

export const TunnelMethod = {
  BACKHAUL: "BACKHAUL",
  FRP: "FRP",
  GOST: "GOST", // Paqet / packet relay backed by gost
  SSH: "SSH",
  PORT_FORWARD: "PORT_FORWARD",
  DIRECT: "DIRECT", // single-node direct forward (listen -> target, no peer dial)
  REVERSE: "REVERSE", // NAT-friendly reverse: Iran dials out, Foreign exposes port
  XRAY: "XRAY", // Xray-core outbound (VLESS/VMess/Trojan/Shadowsocks, WS/TCP/gRPC, TLS/Reality)
  XUI: "XUI", // managed via X-UI / 3X-UI panel API (no local binary)
} as const;
export type TunnelMethod = (typeof TunnelMethod)[keyof typeof TunnelMethod];

export const TunnelMethodSchema = z.enum([
  TunnelMethod.BACKHAUL,
  TunnelMethod.FRP,
  TunnelMethod.GOST,
  TunnelMethod.SSH,
  TunnelMethod.PORT_FORWARD,
  TunnelMethod.DIRECT,
  TunnelMethod.REVERSE,
  TunnelMethod.XRAY,
  TunnelMethod.XUI,
]);

export const NodeType = {
  IRAN: "IRAN",
  FOREIGN: "FOREIGN",
} as const;
export type NodeType = (typeof NodeType)[keyof typeof NodeType];
export const NodeTypeSchema = z.enum([NodeType.IRAN, NodeType.FOREIGN]);

export const TunnelStatus = {
  STOPPED: "stopped",
  STARTING: "starting",
  RUNNING: "running",
  DEGRADED: "degraded",
  ERROR: "error",
  STOPPING: "stopping",
} as const;
export type TunnelStatus = (typeof TunnelStatus)[keyof typeof TunnelStatus];
export const TunnelStatusSchema = z.enum([
  TunnelStatus.STOPPED,
  TunnelStatus.STARTING,
  TunnelStatus.RUNNING,
  TunnelStatus.DEGRADED,
  TunnelStatus.ERROR,
  TunnelStatus.STOPPING,
]);

export const NodeStatus = {
  OFFLINE: "offline",
  ONLINE: "online",
  UNKNOWN: "unknown",
} as const;
export type NodeStatus = (typeof NodeStatus)[keyof typeof NodeStatus];
export const NodeStatusSchema = z.enum([
  NodeStatus.OFFLINE,
  NodeStatus.ONLINE,
  NodeStatus.UNKNOWN,
]);

export const Role = {
  SUPER_ADMIN: "SUPER_ADMIN",
  ADMIN: "ADMIN",
  USER: "USER",
} as const;
export type Role = (typeof Role)[keyof typeof Role];
export const RoleSchema = z.enum([Role.SUPER_ADMIN, Role.ADMIN, Role.USER]);

export const NodeRole = {
  IRAN: "IRAN",
  FOREIGN: "FOREIGN",
  BOTH: "BOTH",
} as const;

// ---------------------------------------------------------------------------
// Backhaul (Musixal/Backhaul) tunnel
// ---------------------------------------------------------------------------

export const BackhaulTransport = {
  TCP: "tcp",
  WEBSOCKET: "websocket",
  QUIC: "quic",
} as const;
export type BackhaulTransport =
  (typeof BackhaulTransport)[keyof typeof BackhaulTransport];

export const BackhaulCongestion = {
  CUBIC: "cubic",
  NEW_RENO: "new_reno",
  BBR: "bbr",
} as const;
export type BackhaulCongestion =
  (typeof BackhaulCongestion)[keyof typeof BackhaulCongestion];

export const BackhaulConfigSchema = z.object({
  role: z.enum(["client", "server"]),
  transport: z.enum([
    BackhaulTransport.TCP,
    BackhaulTransport.WEBSOCKET,
    BackhaulTransport.QUIC,
  ]).default(BackhaulTransport.TCP),
  // server side: listen address+port; client side: target server address
  //
  // Both were bare `z.string()`. `listenAddress` is spliced into
  // `bind_addr = "<addr>:<port>"`, so an empty one produced `":3080"` -- and
  // backhaul does not reject that. Measured on the target OS with the pinned
  // binary: it binds, listens, and ACCEPTS a client connection, so the tunnel
  // reports itself running while the operator's intended address was never
  // honoured. Same failure shape as TASK-131 (GOST) and TASK-133 (SSH).
  listenAddress: hostLikeAddress.default("0.0.0.0"),
  listenPort: z.number().int().min(1).max(65535),
  // Falls back to loopback when omitted, which is a real address rather than a
  // half one, so it stays optional -- but when given it must be an address.
  remoteHost: hostLikeAddress.optional(),
  token: z.string().min(1),
  multiplexing: z.boolean().default(true),
  muxConcurrency: z.number().int().min(1).max(2048).default(64),
  heartbeat: z.number().int().min(1).max(600).default(40),
  channelSize: z.number().int().min(1).max(1e6).default(2048),
  bufferSize: z.number().int().min(1).max(1e6).default(65536),
  congestion: z
    .enum([
      BackhaulCongestion.CUBIC,
      BackhaulCongestion.NEW_RENO,
      BackhaulCongestion.BBR,
    ])
    .default(BackhaulCongestion.CUBIC),
  encryption: z.boolean().default(true),
  portMap: z
    .array(
      z.object({
        local: z.number().int().min(1).max(65535),
        remote: z.number().int().min(1).max(65535),
      }),
    )
    .default([]),
});
export type BackhaulConfig = z.infer<typeof BackhaulConfigSchema>;

// ---------------------------------------------------------------------------
// FRP (fatedier/frp) tunnel
// ---------------------------------------------------------------------------

export const FrpProtocol = {
  TCP: "tcp",
  UDP: "udp",
  HTTP: "http",
  HTTPS: "https",
  STCP: "stcp",
  XTCP: "xtcp",
  SUDP: "sudp",
} as const;
export type FrpProtocol = (typeof FrpProtocol)[keyof typeof FrpProtocol];

export const FrpProxySchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),
  type: z.enum([
    FrpProtocol.TCP,
    FrpProtocol.UDP,
    FrpProtocol.HTTP,
    FrpProtocol.HTTPS,
    FrpProtocol.STCP,
    FrpProtocol.XTCP,
    FrpProtocol.SUDP,
  ]),
  localIP: z.string().default("127.0.0.1"),
  localPort: z.number().int().min(1).max(65535),
  remotePort: z.number().int().min(1).max(65535).optional(),
  customDomains: z.array(z.string()).optional(),
  transport: z
    .object({
      encryption: z.boolean().default(true),
      compression: z.boolean().default(true),
      bandwidthLimit: z.string().optional(),
    })
    .default({}),
  // STCP/XTCP: visitors must share the secret and reference serverName
  secretKey: z.string().optional(),
  serverName: z.string().optional(),
  // STCP/XTCP/SUDP side: server (exposes) or visitor (consumes)
  role: z.enum(["server", "visitor"]).optional(),
  // TASK-132: `addr` and `port` were offered here, but frpc 0.70.1 -- the version
  // install.sh pins -- rejects both under `[proxies.plugin]` as unknown fields,
  // so a proxy configured with them could not start. They belong to frp's
  // per-plugin option structs (HTTPProxyPluginOptions and friends), which this
  // schema does not model. They are removed rather than left accepted-but-ignored
  // or silently defaulted to "" and 0.
  plugin: z
    .object({
      type: z.string().optional(),
    })
    .optional(),
});
export type FrpProxy = z.infer<typeof FrpProxySchema>;

export const FrpServerConfigSchema = z.object({
  role: z.literal("server"),
  bindPort: z.number().int().min(1).max(65535).default(7000),
  bindUdpPort: z.number().int().min(1).max(65535).optional(),
  token: z.string().min(1),
  dashboard: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().min(1).max(65535).optional(),
      user: z.string().optional(),
      password: z.string().optional(),
    })
    .default({}),
  allowPorts: z.array(z.string()).optional(),
});
export type FrpServerConfig = z.infer<typeof FrpServerConfigSchema>;

export const FrpClientConfigSchema = z.object({
  role: z.literal("client"),
  serverAddr: z.string().min(1),
  serverPort: z.number().int().min(1).max(65535).default(7000),
  token: z.string().min(1),
  proxies: z.array(FrpProxySchema).min(1),
});
export type FrpClientConfig = z.infer<typeof FrpClientConfigSchema>;

/**
 * A tunnel-level FRP config drives BOTH processes: the server runs on the
 * Foreign node, the client on the Iran node.
 */
export const FrpConfigSchema = z.object({
  bindPort: z.number().int().min(1).max(65535).default(7000),
  bindUdpPort: z.number().int().min(1).max(65535).optional(),
  token: z.string().min(1),
  dashboard: z
    .object({
      enabled: z.boolean().default(false),
      port: z.number().int().min(1).max(65535).optional(),
      user: z.string().optional(),
      password: z.string().optional(),
    })
    .default({}),
  proxies: z.array(FrpProxySchema).min(1),
  allowPorts: z.array(z.string()).optional(),
});
export type FrpConfig = z.infer<typeof FrpConfigSchema>;

// ---------------------------------------------------------------------------
// GOST (Go Simple Tunnel) / Paqet packet relay

// ---------------------------------------------------------------------------

export const GostProtocol = {
  TCP: "tcp",
  UDP: "udp",
} as const;
export type GostProtocol = (typeof GostProtocol)[keyof typeof GostProtocol];

export const GostConfigSchema = z.object({
  // bidirectional: true => run relay on both nodes, false => single hop
  bidirectional: z.boolean().default(false),
  direction: z.enum([NodeType.IRAN, NodeType.FOREIGN]),
  protocol: z
    .enum([GostProtocol.TCP, GostProtocol.UDP])
    .default(GostProtocol.TCP),
  listenPort: z.number().int().min(1).max(65535),
  remoteHost: z.string().optional(),
  remotePort: z.number().int().min(1).max(65535).optional(),
  // Relay target. The pair is REQUIRED and must be present together: both feed
  // `listenerTarget()` in config/gost.ts, which splices them into one
  // `proto://:listen/host:port` token, and gost does NOT reject a blank one.
  //
  // Left optional (as this was), a config with a cleared forwardHost and no
  // forwardPort validated cleanly, was stored, and produced `tcp://:9000/:`.
  // gost starts and LISTENS on that, accepts every connection, and refuses all
  // of them -- measured on the target OS:
  //
  //   forward.go:137: [tcp] 127.0.0.1:11514 -> 127.0.0.1:19099
  //               : dial tcp :0: connect: connection refused
  //
  // so the tunnel looked started while carrying nothing. REVERSE already holds
  // its equivalent pair required; GOST is held the same way.
  forwardHost: hostLikeAddress,
  forwardPort: z.number().int().min(1).max(65535),
  ttl: z.number().int().min(0).max(3600).default(60),
  bufferSize: z.number().int().min(1024).max(1048576).default(65536),
  udpDataBufferSize: z.number().int().min(1024).max(1048576).default(65536),
});
export type GostConfig = z.infer<typeof GostConfigSchema>;

// ---------------------------------------------------------------------------
// SSH tunnel
// ---------------------------------------------------------------------------

export const SshMode = {
  LOCAL: "local",
  REMOTE: "remote",
  DYNAMIC: "dynamic",
} as const;
export type SshMode = (typeof SshMode)[keyof typeof SshMode];

export const SshConfigSchema = z.object({
  mode: z.enum([SshMode.LOCAL, SshMode.REMOTE, SshMode.DYNAMIC]),
  // A leading "-" would be parsed by ssh as an OPTION, not a destination, and
  // a metacharacter would survive into the destination token. Both are refused
  // here; buildSshCommand re-checks so a caller that bypasses this schema is
  // still safe. See assertSafeSshDestination in tunnel-core/config/ssh.ts.
  host: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9.:_-]{0,252}$/, "host must be a hostname or IP literal without shell characters"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/, "username must be a plain POSIX user name, not an ssh option"),
  auth: z.enum(["key", "password"]).default("key"),
  // key path or PEM content (encrypted at rest by the panel)
  keyPath: z.string().optional(),
  key: z.string().optional(),
  password: z.string().optional(),
  // local forwarding: -L [bindAddr:]localPort:remoteHost:remotePort
  //
  // These five were bare `z.string().default(...)` while `host` and `username`
  // above were held to strict patterns for a stated reason: a leading "-" is
  // read by ssh as an OPTION and a delimiter inside one of these values lands in
  // a single `-L`/`-R` token. That reason applies to all of them equally, so
  // they are held to the same bare-address rule DIRECT and REVERSE use.
  //
  // Measured through buildSshCommand before this change:
  //   remoteHost "198.51.100.7:22@evil.example" ACCEPTED
  //     -> -L 127.0.0.1:8080:198.51.100.7:22@evil.example:80
  //   remoteHost "-oProxyCommand=id"           ACCEPTED
  //     -> -L 127.0.0.1:8080:-oProxyCommand=id:80
  //   remoteHost ""                           ACCEPTED
  //     -> -L 127.0.0.1:8080::80
  //
  // None of those is command injection: argv is passed as an array, so ssh
  // receives them as opaque data. But each is a corrupt forward that binds a
  // port and carries nothing -- the same "looks started, transports nothing"
  // shape TASK-131 found in GOST, and the reason these are no longer free text.
  localBindAddr: hostLikeAddress.default("127.0.0.1"),
  localPort: z.number().int().min(1).max(65535),
  remoteHost: hostLikeAddress.default("127.0.0.1"),
  remotePort: z.number().int().min(1).max(65535),
  // remote forwarding: -R [bindAddr:]remotePort:localHost:localPort
  remoteBindAddr: hostLikeAddress.default("0.0.0.0"),
  dynamicBindAddr: hostLikeAddress.default("127.0.0.1"),
  // Extra raw SSH argv. Fail closed: any non-empty value is rejected because
  // raw argv appended to the SSH command is an RCE vector (-o ProxyCommand=).
  // The panel UI always sends []. Defense-in-depth filtering also lives in
  // buildSshCommand (tunnel-core).
  extraArgs: z.array(z.string()).max(0).default([]),
  // Prefer the autossh wrapper for resilient reconnection (auto-restarts the
  // underlying ssh process when a connection drops). The engine falls back to
  // a plain `ssh` command when autossh is not installed on the target node.
  useAutossh: z.boolean().default(true),
  // autossh -M monitor port. 0 disables the built-in echo-port monitor and
  // relies solely on ssh ServerAliveInterval/CountMax (recommended).
  autosshMonitorPort: z.number().int().min(0).max(65535).default(0),
  // autossh poll interval (seconds) between connection health checks.
  autosshPoll: z.number().int().min(1).max(3600).default(60),
});
export type SshConfig = z.infer<typeof SshConfigSchema>;

// ---------------------------------------------------------------------------
// DIRECT tunnel: simplest possible forward on ONE node.
// Listens on listenPort and forwards to targetHost:targetPort (gost -L).
// Use when both ends are directly reachable (no NAT/censorship hop needed).
// ---------------------------------------------------------------------------

// A bare address as it may appear inside a gost URL: hostname, IPv4, or IPv6
// literal (unbracketed -- buildDirectCommand adds the brackets). `/ ? # @`,
// whitespace, control characters, a scheme, and a leading "-" are all refused,
// because each corrupts or hijacks the URL silently rather than failing loudly.
// See assertSafeDirectAddress in tunnel-core/config/direct.ts, which re-checks
// so a caller that bypasses this schema is still safe.

export const DirectConfigSchema = z.object({
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
  bindAddr: hostLikeAddress.default("0.0.0.0"),
  listenPort: z.number().int().min(1).max(65535),
  targetHost: hostLikeAddress,
  targetPort: z.number().int().min(1).max(65535),
});
export type DirectConfig = z.infer<typeof DirectConfigSchema>;

// ---------------------------------------------------------------------------
// REVERSE tunnel: one-click NAT-friendly reverse forward (ssh -R under the
// hood, wrapped in autossh when available — same machinery as SSH tunnels).
// Runs ON the Iran node and dials out to the Foreign sshd, so Iran needs no
// inbound firewall rule; the Foreign side exposes listenPort to the world
// and traffic is carried back to forwardHost:forwardPort in Iran.
// TCP only: OpenSSH -R cannot forward UDP.
// ---------------------------------------------------------------------------

export const ReverseConfigSchema = z.object({
  protocol: z.literal("tcp").default("tcp"),
  listenPort: z.number().int().min(1).max(65535),
  // forwardHost and remoteBindAddr are both concatenated into the single
  // `-R bindAddr:listenPort:forwardHost:forwardPort` argument, so a "/", a
  // space or a leading "-" in either silently changes what that argument
  // means. Both are therefore held to the same bare-address rule DIRECT uses
  // (see hostLikeAddress): a hostname, IPv4 literal, or IPv6 literal.
  forwardHost: hostLikeAddress.default("127.0.0.1"),
  forwardPort: z.number().int().min(1).max(65535),
  // SSH hop to the Foreign side. Empty host falls back to the Foreign
  // node's address at deploy time (see reverseToSshConfig). The pattern is the
  // one SshConfigSchema uses: this config is mapped straight into an ssh
  // destination, and a leading "-" there is read by ssh as an OPTION.
  host: z
    .string()
    .default("")
    .refine((v) => v === "" || /^[A-Za-z0-9_][A-Za-z0-9.:_-]{0,252}$/.test(v), {
      message:
        "host must be empty, or a hostname/IP literal without shell characters or a leading '-'",
    }),
  port: z.number().int().min(1).max(65535).default(22),
  username: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/, "username must be a plain POSIX user name, not an ssh option")
    .default("root"),
  auth: z.enum(["key", "password"]).default("key"),
  key: z.string().optional(),
  password: z.string().optional(),
  remoteBindAddr: hostLikeAddress.default("0.0.0.0"),
  extraArgs: z.array(z.string()).max(0).default([]),
  useAutossh: z.boolean().default(true),
  autosshMonitorPort: z.number().int().min(0).max(65535).default(0),
  autosshPoll: z.number().int().min(1).max(3600).default(60),
});
export type ReverseConfig = z.infer<typeof ReverseConfigSchema>;

// ---------------------------------------------------------------------------
// XRAY tunnel: runs xray-core locally with a minimal dokodemo-door inbound
// (listenPort) forwarding into a single outbound (VLESS/VMess/Trojan/
// Shadowsocks over TCP/WS/gRPC with optional TLS/Reality). Compatible with
// upstreams managed by X-UI / 3X-UI panels — paste the inbound credentials
// from 3X-UI into the wizard and the panel generates the xray JSON.
// ---------------------------------------------------------------------------

export const XrayProtocol = {
  VLESS: "vless",
  VMESS: "vmess",
  TROJAN: "trojan",
  SHADOWSOCKS: "shadowsocks",
} as const;
export type XrayProtocol = (typeof XrayProtocol)[keyof typeof XrayProtocol];

/**
 * The Xray credential: a UUID for VLESS/VMess, and the password for
 * Trojan/Shadowsocks.
 *
 * Validation exists because this value is written verbatim to a config file
 * that holds it in the clear, and because a control character in it produces a
 * JSON document that is technically valid but that xray cannot use. Bounded
 * at 128 so a paste of the wrong thing is refused at the API rather than
 * becoming a credential-shaped blob on disk.
 */
const xrayCredential = z
  .string()
  .min(1, "credential must not be empty")
  .max(128, "credential must be at most 128 characters")
  .refine((v) => v.trim() === v, "credential must not have leading or trailing whitespace")
  .refine(
    (v) => !/[\s\u0000-\u001f\u007f]/.test(v),
    "credential must not contain whitespace or control characters",
  )
  // An X25519 public key (Reality) is base64url; a UUID is hex-dashed; a
  // Shadowsocks/Trojan password is printable ASCII. Rejecting everything else
  // is what stops "your-uuid-here" being stored as if it were a credential.
  .refine(
    (v) => /^[A-Za-z0-9+/_=-]{8,128}$/.test(v),
    "credential must be a UUID, an X25519 public key, or a password of printable characters (no spaces)",
  );

/** A Reality outbound cannot work without the server's public key. */
const xrayPublicKey = z
  .string()
  .min(40, "Reality publicKey must be a base64url X25519 key")
  .max(64, "Reality publicKey must be at most 64 characters")
  .refine((v) => /^[A-Za-z0-9_-]+={0,2}$/.test(v), "Reality publicKey must be base64url");

export const XrayConfigSchema = z
  .object({
    listenPort: z.number().int().min(1).max(65535),
    protocol: z.enum(["vless", "vmess", "trojan", "shadowsocks"]).default("vless"),
    // hostLikeAddress, not a bare string: `address` reaches xray's outbound
    // verbatim, and a leading "-" or an embedded "/" changes what it means.
    address: hostLikeAddress,
    port: z.number().int().min(1).max(65535),
    uuid: xrayCredential,
    network: z.enum(["tcp", "ws", "grpc"]).default("tcp"),
    security: z.enum(["none", "tls", "reality"]).default("none"),
    sni: z.string().optional(),
    path: z.string().optional(),
    flow: z.string().optional(),
    publicKey: xrayPublicKey.optional(),
    shortId: z.string().max(16, "Reality shortId must be at most 16 hex characters").optional(),
    fingerprint: z.string().max(16).optional(),
  })
  .refine((v) => v.security !== "reality" || !!v.publicKey, {
    message: "Reality requires the server's publicKey (Reality Security > Public key in 3X-UI)",
    path: ["publicKey"],
  });
export type XrayConfig = z.infer<typeof XrayConfigSchema>;

// ---------------------------------------------------------------------------
// XUI tunnel: metadata-only integration with an X-UI / 3X-UI panel.
// No binary runs on our nodes; the panel stores the 3X-UI credentials and
// inbound id, verifies reachability via its HTTP API (see /api/xui/*), and
// reports status from the last successful sync. This keeps low-memory VPSes
// free of extra processes.
// ---------------------------------------------------------------------------

export const XuiConfigSchema = z.object({
  /**
   * The 3X-UI panel base URL.
   *
   * This field is deliberately NOT restricted to public addresses: 3X-UI
   * panels usually run on the operator's own VPS, often on a private or
   * tailnet address, and `/api/xui/test` intentionally omits the SSRF
   * private-IP block for that reason. The exception is bounded by this
   * endpoint alone -- `/api/tools` keeps its guard.
   *
   * What IS enforced here, because neither is needed for a private panel and
   * both are dangerous:
   *  - http/https only. `file:`, `gopher:`, `data:` and `javascript:` are
   *    accepted by a bare `z.string().url()` and would let the panel URL
   *    become a local-file read or an injected scheme.
   *  - no credentials in the URL. `https://user:pass@host` puts a secret into a
   *    value that is logged, stored and shown in the UI, and it also defeats
   *    the "credentials only in the intended field" rule.
   */
  panelUrl: z
    .string()
    .url("panelUrl must be a valid URL")
    .max(256)
    .refine((v) => /^https?:\/\//i.test(v), {
      message: "panelUrl must start with http:// or https://",
    })
    .refine((v) => {
      try {
        const u = new URL(v);
        return !u.username && !u.password;
      } catch {
        return false;
      }
    }, { message: "Put the panel credentials in the username/password fields, not in the URL" }),
  username: z.string().min(1),
  password: z.string().min(1),
  inboundId: z.number().int().min(1).optional(),
  remark: z.string().max(120).optional(),
  syncInterval: z.number().int().min(30).max(3600).default(300),
  listenPort: z.number().int().min(1).max(65535).optional(),
});
export type XuiConfig = z.infer<typeof XuiConfigSchema>;

// ---------------------------------------------------------------------------
// Bidirectional port forwarding rules
// ---------------------------------------------------------------------------

export const PortForwardDirection = {
  IRAN_TO_FOREIGN: "IRAN_TO_FOREIGN",
  FOREIGN_TO_IRAN: "FOREIGN_TO_IRAN",
} as const;
export type PortForwardDirection =
  (typeof PortForwardDirection)[keyof typeof PortForwardDirection];

export const PortForwardProtocol = {
  TCP: "tcp",
  UDP: "udp",
} as const;
export type PortForwardProtocol =
  (typeof PortForwardProtocol)[keyof typeof PortForwardProtocol];

export const PortForwardRuleSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(80),
  direction: z.enum([
    PortForwardDirection.IRAN_TO_FOREIGN,
    PortForwardDirection.FOREIGN_TO_IRAN,
  ]),
  protocol: z.enum([PortForwardProtocol.TCP, PortForwardProtocol.UDP]),
  sourcePort: z.number().int().min(1).max(65535),
  destHost: z.string().min(1),
  destPort: z.number().int().min(1).max(65535),
  enabled: z.boolean().default(true),
});
export type PortForwardRule = z.infer<typeof PortForwardRuleSchema>;

// ---------------------------------------------------------------------------
// Tunnel envelope
// ---------------------------------------------------------------------------

export const TunnelConfigSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal(TunnelMethod.BACKHAUL),
    backhaul: BackhaulConfigSchema,
  }),
  z.object({
    method: z.literal(TunnelMethod.FRP),
    frp: FrpConfigSchema,
  }),
  z.object({
    method: z.literal(TunnelMethod.GOST),
    gost: GostConfigSchema,
  }),
  z.object({
    method: z.literal(TunnelMethod.SSH),
    ssh: SshConfigSchema,
  }),
  z.object({
    method: z.literal(TunnelMethod.PORT_FORWARD),
    portForwards: z.array(PortForwardRuleSchema).min(1),
  }),
  z.object({
    method: z.literal(TunnelMethod.DIRECT),
    direct: DirectConfigSchema,
  }),
  z.object({
    method: z.literal(TunnelMethod.REVERSE),
    reverse: ReverseConfigSchema,
  }),
  z.object({
    method: z.literal(TunnelMethod.XRAY),
    xray: XrayConfigSchema,
  }),
  z.object({
    method: z.literal(TunnelMethod.XUI),
    xui: XuiConfigSchema,
  }),
]);
export type TunnelConfig = z.infer<typeof TunnelConfigSchema>;

// ---------------------------------------------------------------------------
// Node model
// ---------------------------------------------------------------------------

export const NodeConfigSchema = z.object({
  name: z.string().min(1).max(80),
  type: NodeTypeSchema,
  // host and username are spliced into the ssh destination token
  // `${username}@${host}` by BOTH the node test route
  // (app/api/nodes/[id]/test/route.ts) and RemoteRunner.baseArgs
  // (tunnel-core/src/runner.ts). ssh parses ANY leading-dash argv token as an
  // OPTION before it looks for a destination, so a username of
  // `-oProxyCommand=<cmd>` executed that command on the panel host. Verified by
  // execution, not by reading. Same rules and rationale as SshConfigSchema.
  host: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9.:_-]{0,252}$/, "host must be a hostname or IP literal without shell characters"),
  port: z.number().int().min(1).max(65535).default(22),
  username: z
    .string()
    .regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/, "username must be a plain POSIX user name, not an ssh option"),
  authMethod: z.enum(["key", "password"]).default("key"),
  key: z.string().optional(),
  password: z.string().optional(),
  apiToken: z.string().optional(),
});
export type NodeConfig = z.infer<typeof NodeConfigSchema>;

// ---------------------------------------------------------------------------
// Health / stats / events
// ---------------------------------------------------------------------------

export const TrafficSnapshotSchema = z.object({
  bytesIn: z.number().nonnegative(),
  bytesOut: z.number().nonnegative(),
  speedInBps: z.number().nonnegative(),
  speedOutBps: z.number().nonnegative(),
  uptimeMs: z.number().nonnegative(),
  status: TunnelStatusSchema,
});
export type TrafficSnapshot = z.infer<typeof TrafficSnapshotSchema>;

export const TunnelEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), status: TunnelStatusSchema }),
  z.object({
    type: z.literal("traffic"),
    snapshot: TrafficSnapshotSchema,
  }),
  z.object({ type: z.literal("log"), stream: z.enum(["stdout", "stderr"]), line: z.string() }),
  z.object({ type: z.literal("deleted") }),
]);
export type TunnelEvent = z.infer<typeof TunnelEventSchema>;
