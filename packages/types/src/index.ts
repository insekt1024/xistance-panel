import { z } from "zod";

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

export const TunnelMethod = {
  BACKHAUL: "BACKHAUL",
  FRP: "FRP",
  GOST: "GOST", // Paqet / packet relay backed by gost
  SSH: "SSH",
  PORT_FORWARD: "PORT_FORWARD",
} as const;
export type TunnelMethod = (typeof TunnelMethod)[keyof typeof TunnelMethod];

export const TunnelMethodSchema = z.enum([
  TunnelMethod.BACKHAUL,
  TunnelMethod.FRP,
  TunnelMethod.GOST,
  TunnelMethod.SSH,
  TunnelMethod.PORT_FORWARD,
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
  listenAddress: z.string().default("0.0.0.0"),
  listenPort: z.number().int().min(1).max(65535),
  remoteHost: z.string().optional(),
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
  plugin: z
    .object({
      type: z.string().optional(),
      addr: z.string().optional(),
      port: z.number().int().optional(),
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
  // UDP forward chain: relay target
  forwardHost: z.string().optional(),
  forwardPort: z.number().int().min(1).max(65535).optional(),
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
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1),
  auth: z.enum(["key", "password"]).default("key"),
  // key path or PEM content (encrypted at rest by the panel)
  keyPath: z.string().optional(),
  key: z.string().optional(),
  password: z.string().optional(),
  // local forwarding: -L [bindAddr:]localPort:remoteHost:remotePort
  localBindAddr: z.string().default("127.0.0.1"),
  localPort: z.number().int().min(1).max(65535),
  remoteHost: z.string().default("127.0.0.1"),
  remotePort: z.number().int().min(1).max(65535),
  // remote forwarding: -R [bindAddr:]remotePort:localHost:localPort
  remoteBindAddr: z.string().default("0.0.0.0"),
  dynamicBindAddr: z.string().default("127.0.0.1"),
  // Extra raw SSH argv. Fail closed: any non-empty value is rejected because
  // raw argv appended to the SSH command is an RCE vector (-o ProxyCommand=).
  // The panel UI always sends []. Defense-in-depth filtering also lives in
  // buildSshCommand (tunnel-core).
  extraArgs: z.array(z.string()).max(0).default([]),
});
export type SshConfig = z.infer<typeof SshConfigSchema>;

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
]);
export type TunnelConfig = z.infer<typeof TunnelConfigSchema>;

// ---------------------------------------------------------------------------
// Node model
// ---------------------------------------------------------------------------

export const NodeConfigSchema = z.object({
  name: z.string().min(1).max(80),
  type: NodeTypeSchema,
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).default("root"),
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
