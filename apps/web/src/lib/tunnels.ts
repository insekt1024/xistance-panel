import { ZodError, type ZodIssue } from "zod";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  decryptSecret,
  encryptSecret,
  isLoopback,
  type NodeEndpoint,
  type TunnelDeploySpec,
} from "@xistance/tunnel-core";
import { TunnelConfigSchema, type TunnelConfig } from "@xistance/types";
import type { Node as DbNode, Tunnel as DbTunnel } from "@xistance/db";

// ---------------------------------------------------------------------------
// Tunnel config storage: the full config (tokens, keys, passwords) is stored
// encrypted at rest inside the Prisma Json field as { "enc": "<ciphertext>" }.
// A redacted copy is NOT kept; decryption happens only when deploying.
// ---------------------------------------------------------------------------

export function storeTunnelConfig(config: TunnelConfig): { enc: string } {
  return { enc: encryptSecret(JSON.stringify(config)) };
}

export function loadTunnelConfig(
  stored: unknown,
): TunnelConfig {
  const raw =
    typeof stored === "object" && stored !== null && "enc" in stored
      ? (stored as { enc: string }).enc
      : JSON.stringify(stored);
  try {
    const parsed = TunnelConfigSchema.parse(JSON.parse(decryptSecret(raw)));
    return parsed;
  } catch {
    // Legacy plaintext configs (pre-encryption rows store raw JSON): fall
    // back to parsing the stored value directly instead of crashing.
    // Only throw if BOTH the decrypt path and the plaintext path fail.
    const plain = typeof stored === "string" ? stored : JSON.stringify(stored);
    try {
      const parsed = TunnelConfigSchema.parse(JSON.parse(plain));
      console.warn("[tunnels] loaded legacy plaintext tunnel config; re-save to migrate to encrypted storage");
      return parsed;
    } catch (e) {
      // Re-throw as something an operator can act on.
      //
      // A ZodError's `.message` is a JSON dump of every issue, and it was
      // travelling verbatim from here to the API response to the UI -- 348
      // characters naming internal paths like `gost.forwardHost`. That happens
      // for any row stored BEFORE a schema was tightened (GOST's required relay
      // target in TASK-131 is the current example): the tunnel is unstartable,
      // and the only clue it gives is a schema dump.
      throw new Error(describeConfigProblem(e));
    }
  }
}

/**
 * Turn a schema failure into one sentence an operator can act on.
 *
 * A row stored before a schema tightened cannot be repaired by re-validating it,
 * so the useful message names the tunnel's method, the offending field, and the
 * remedy -- not the internal issue object.
 */
/**
 * One clause describing what is wrong, in the operator's terms.
 *
 * Zod's own messages are developer-facing ("String must contain at least 1
 * character(s)"), and they were reaching the UI verbatim. Only the three cases
 * that a stored row can actually hit are translated; anything unrecognised falls
 * back to a generic clause rather than leaking the raw message.
 */
function describeIssue(issue: ZodIssue | undefined): string {
  if (!issue) return "is not valid";
  if (issue.code === "invalid_type" && issue.received === "undefined") return "is missing";
  if (issue.code === "unrecognized_keys") return "has fields this version no longer accepts";
  if (issue.code === "too_small" && /at least 1 character/.test(issue.message ?? "")) {
    return "is empty";
  }
  if (issue.code === "custom" || issue.code === "invalid_string" || /must not|must be/.test(issue.message ?? "")) {
    return "has a value this version does not accept";
  }
  return "is not valid";
}

function describeConfigProblem(e: unknown): string {
  if (e instanceof ZodError) {
    const first = e.issues[0];
    const field = first?.path.length ? first.path.join(".") : "config";
    const what = describeIssue(first);
    return (
      `This tunnel's stored configuration is no longer valid: "${field}" ${what}. ` +
      `It was saved by an earlier version of the panel. Delete the tunnel and ` +
      `create it again with the current fields.`
    );
  }
  if (e instanceof Error) return e.message;
  return "This tunnel's stored configuration could not be read.";
}

// ---------------------------------------------------------------------------
// Node key materialisation: decrypted SSH keys are written to the panel's key
// store so system ssh / remote runners can reference them by path.
// ---------------------------------------------------------------------------

async function ensureKeyFile(nodeId: string, pem: string): Promise<string> {
  const dir =
    process.env.XT_KEY_DIR ?? path.join(process.env.XT_DATA_DIR ?? path.resolve(process.cwd(), "..", "..", "tunnels"), "keys");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `node-${nodeId}.pem`);
  // Only write if file doesn't exist or content differs (avoid redundant I/O / race conditions)
  const existing = await fs.readFile(file, "utf8").catch(() => null);
  if (existing !== pem) {
    await fs.writeFile(file, pem, { mode: 0o600 });
  }
  return file;
}

export function isPanelHost(host: string): boolean {
  const panelHost = process.env.XT_PANEL_HOST;
  return (
    isLoopback(host) || (!!panelHost && host.trim() === panelHost.trim())
  );
}

/** Build a tunnel-core NodeEndpoint from a DB node, decrypting secrets. */
export async function nodeToEndpoint(
  node: Pick<DbNode, "id" | "host" | "sshUser" | "sshPort" | "authMethod" | "sshKeyEncrypted" | "sshPasswordEnc">,
): Promise<NodeEndpoint> {
  let keyPath: string | undefined;
  if (node.sshKeyEncrypted) {
    const pem = decryptSecret(node.sshKeyEncrypted);
    keyPath = await ensureKeyFile(node.id, pem);
  }
  return {
    id: node.id,
    host: node.host,
    username: node.sshUser,
    isLocal: isPanelHost(node.host),
    sshPort: node.sshPort,
    authMethod: (node.authMethod as "key" | "password") ?? "key",
    keyPath,
    password: node.sshPasswordEnc ? decryptSecret(node.sshPasswordEnc) : undefined,
  };
}

export async function buildDeploySpec(
  tunnel: Pick<DbTunnel, "id" | "name" | "method" | "config" | "clientNodeId" | "serverNodeId">,
  clientNode: Pick<DbNode, "id" | "host" | "sshUser" | "sshPort" | "authMethod" | "sshKeyEncrypted" | "sshPasswordEnc"> | null,
  serverNode: Pick<DbNode, "id" | "host" | "sshUser" | "sshPort" | "authMethod" | "sshKeyEncrypted" | "sshPasswordEnc"> | null,
): Promise<TunnelDeploySpec> {
  const config = loadTunnelConfig(tunnel.config);
  return buildSpec(
    tunnel.id,
    tunnel.name,
    tunnel.method as TunnelDeploySpec["method"],
    config,
    clientNode,
    serverNode,
  );
}

/** Build a deploy spec from a validated config + DB nodes (used on create). */
export async function buildSpec(
  id: string,
  name: string,
  method: TunnelDeploySpec["method"],
  config: TunnelConfig,
  clientNode: Pick<DbNode, "id" | "host" | "sshUser" | "sshPort" | "authMethod" | "sshKeyEncrypted" | "sshPasswordEnc"> | null,
  serverNode: Pick<DbNode, "id" | "host" | "sshUser" | "sshPort" | "authMethod" | "sshKeyEncrypted" | "sshPasswordEnc"> | null,
): Promise<TunnelDeploySpec> {
  return {
    id,
    name,
    method,
    config,
    clientNode: clientNode ? await nodeToEndpoint(clientNode) : null,
    serverNode: serverNode ? await nodeToEndpoint(serverNode) : null,
  };
}

export function redactNode(node: DbNode) {
  const { sshKeyEncrypted, sshPasswordEnc, apiTokenEncrypted, ...rest } = node;
  return {
    ...rest,
    hasKey: Boolean(sshKeyEncrypted),
    hasPassword: Boolean(sshPasswordEnc),
    hasApiToken: Boolean(apiTokenEncrypted),
  };
}

/**
 * Credential field names inside a tunnel config, at any depth.
 *
 * A tunnel's `config` is a JSON blob stored in PLAINTEXT, because the engine
 * has to hand the token to a process at start time. That makes every config
 * field below a live credential, and the backup endpoint exports the blob
 * verbatim -- so an export handed to an operator, pasted into a ticket, or
 * committed to a repo carries every tunnel secret in the install.
 *
 * Matching is by NAME at any depth rather than by an exhaustive per-method
 * list, because the alternative rots: a new method with a new secret field
 * would silently be exported until someone remembered to update a switch.
 * `secretKey` lives on a FRP proxy, `password` on FRP/SSH/XUI, `key` on SSH,
 * REVERSE and ICMP, `token` on BACKHAUL/FRP/XUI, `encryptionKey` on ICMP.
 */
const CONFIG_SECRET_FIELDS = new Set([
  "token",
  "secretkey",
  "password",
  "passphrase",
  "key",
  // pingtunnel's end-to-end payload passphrase. Lowercased to
  // "encryptionkey", so it does NOT match the `key` entry above -- an exact
  // `Set.has("key")` never sees a prefix. Adding ICMP without this line
  // exported the payload encryption secret verbatim in every backup.
  "encryptionkey",
  "encryptkey",
  "apikey",
  "apitoken",
  "privatekey",
  "psk",
  "authkey",
]);

/** Strip credential values from a tunnel config, keeping the shape. */
export function redactTunnelConfig(config: unknown): unknown {
  if (Array.isArray(config)) return config.map(redactTunnelConfig);
  if (config && typeof config === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
      if (CONFIG_SECRET_FIELDS.has(k.toLowerCase())) {
        // Keep the KEY so the restore path can tell "was set" from "never set",
        // but never the value.
        out[k] = "***";
        continue;
      }
      out[k] = redactTunnelConfig(v);
    }
    return out;
  }
  return config;
}

/**
 * The port out of a pingtunnel `-l` listen address: ":1080", "127.0.0.1:1080"
 * and "[::1]:1080" all carry the port in the final colon-separated field.
 *
 * Parsed rather than stored separately because pingtunnel takes ONE token:
 * splitting it into host and port in the schema would let the two disagree, and
 * the schema would then validate a pair that reassembles into something else.
 */
function portFromListenAddr(listenAddr: string): number | null {
  const m = /:(\d{1,5})$/.exec(listenAddr);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

/**
 * Primary exposure port for a tunnel, used for display and the port-conflict
 * check. Lives here rather than in the route: it is a pure function of the
 * config with no request context, and the switch must stay exhaustive as
 * methods are added (TypeScript enforces that via the discriminated union).
 */
export function extractPort(config: TunnelConfig): number | null {
  switch (config.method) {
    case "BACKHAUL":
      return config.backhaul.listenPort;
    case "FRP":
      return config.frp.bindPort;
    case "GOST":
      return config.gost.listenPort;
    case "ICMP":
      // SOCKS5 mode still listens locally, so the port exists either way; it
      // parses to null only if the address is malformed, and the schema has
      // already bounded the shape.
      return portFromListenAddr(config.icmp.listenAddr);
    case "SSH":
      return config.ssh.localPort;
    case "PORT_FORWARD":
      return config.portForwards[0]?.sourcePort ?? null;
    case "DIRECT":
      return config.direct.listenPort;
    case "REVERSE":
      return config.reverse.listenPort;
    case "XRAY":
      return config.xray.listenPort;
    case "XUI":
      return config.xui.listenPort ?? null;
  }
}
