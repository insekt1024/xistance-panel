import path from "node:path";
import { promises as fs } from "node:fs";
import {
  decryptSecret,
  encryptSecret,
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
  const parsed = TunnelConfigSchema.parse(JSON.parse(decryptSecret(raw)));
  return parsed;
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
    ["127.0.0.1", "::1", "localhost", "local", "self", "0.0.0.0"].includes(
      host.trim().toLowerCase(),
    ) || (!!panelHost && host.trim() === panelHost.trim())
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
