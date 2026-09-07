import { prisma, type PortForward as DbPortForward, type Node as DbNode } from "@xistance/db";
import { getEngine } from "./engine";
import { buildSpec } from "./tunnels";
import type { PortForwardRule } from "@xistance/types";

type NodeRow = Pick<DbNode, "id" | "name" | "type" | "host" | "sshUser" | "sshPort" | "authMethod" | "sshKeyEncrypted" | "sshPasswordEnc">;
type RuleRow = Pick<DbPortForward, "id" | "name" | "direction" | "protocol" | "sourcePort" | "destHost" | "destPort" | "enabled" | "nodeId" | "status" | "userId">;

// ---------------------------------------------------------------------------
// Port-forward supervisor. Reconciles the enabled rules from the database with
// engine-managed processes (one synthetic PORT_FORWARD tunnel per target node).
// - Rules whose listener node is the panel host run the in-process worker.
// - Rules on a remote node run a gost-forward systemd unit there.
// Call after any CRUD change and on server boot.
// ---------------------------------------------------------------------------

const TUNNEL_PREFIX = "pf-";
const NODE_CACHE_TTL_MS = 30_000;

const active = new Map<string, string>();
let nodeCache: { at: number; data: NodeRow[] } | null = null;

async function getNodes(): Promise<NodeRow[]> {
  const now = Date.now();
  if (nodeCache && now - nodeCache.at < NODE_CACHE_TTL_MS) {
    return nodeCache.data;
  }
  const data = await prisma.node.findMany({
    select: { id: true, name: true, type: true, host: true, sshUser: true, sshPort: true, authMethod: true, sshKeyEncrypted: true, sshPasswordEnc: true },
  });
  nodeCache = { at: now, data };
  return data;
}

/** Force-clear the node cache (call after node CRUD operations). */
export function clearNodeCache(): void {
  nodeCache = null;
}

function toRule(r: Pick<RuleRow, "name" | "direction" | "protocol" | "sourcePort" | "destHost" | "destPort" | "enabled">): PortForwardRule {
  return {
    name: r.name,
    direction: r.direction as PortForwardRule["direction"],
    protocol: r.protocol as PortForwardRule["protocol"],
    sourcePort: r.sourcePort,
    destHost: r.destHost,
    destPort: r.destPort,
    enabled: r.enabled,
  };
}

function resolveTargetNode(
  rule: RuleRow,
  nodes: NodeRow[],
): NodeRow | null {
  if (rule.nodeId) return nodes.find((n) => n.id === rule.nodeId) ?? null;
  const byType = nodes.filter(
    (n) => n.type === (rule.direction === "IRAN_TO_FOREIGN" ? "IRAN" : "FOREIGN"),
  );
  return byType.length === 1 ? byType[0] : null;
}

export async function reconcilePortForwards(): Promise<void> {
  const engine = getEngine();
  const [rules, nodes] = await Promise.all([
    prisma.portForward.findMany({
      select: { id: true, name: true, direction: true, protocol: true, sourcePort: true, destHost: true, destPort: true, enabled: true, nodeId: true, status: true, userId: true },
    }) as Promise<RuleRow[]>,
    getNodes(),
  ]);
  const enabled = rules.filter((r) => r.enabled);

  // Group enabled rules by resolved target node.
  const groups = new Map<string, RuleRow[]>();
  const statuses = new Map<string, string>(); // ruleId -> status
  for (const rule of enabled) {
    const node = resolveTargetNode(rule, nodes);
    if (!node) {
      statuses.set(rule.id, "needs_node");
      continue;
    }
    if (!groups.has(node.id)) groups.set(node.id, []);
    groups.get(node.id)!.push(rule);
    statuses.set(rule.id, "running");
  }
  for (const rule of rules.filter((r) => !r.enabled)) {
    statuses.set(rule.id, "stopped");
  }

  // Deploy/replace one PORT_FORWARD tunnel per node group (in parallel).
  const deployResults = await Promise.all(
    [...groups.entries()].map(async ([nodeId, nodeRules]) => {
      const node = nodes.find((n) => n.id === nodeId)!;
      const tunnelId = `${TUNNEL_PREFIX}${nodeId}`;
      try {
        const spec = await buildSpec(
          tunnelId,
          `Port-forward (${node.name})`,
          "PORT_FORWARD",
          {
            method: "PORT_FORWARD",
            portForwards: nodeRules.map(toRule),
          },
          node.type === "IRAN" ? node : null,
          node.type === "FOREIGN" ? node : null,
        );
        // Always go through the deploy path: engine.restart() only restarts the
        // existing processes and never rewrites rules.json, so rule edits
        // would never take effect. deploy() rewrites the files AND disposes
        // the predecessor runtime first (see TunnelEngine.deploy).
        await engine.deploy(spec);
        return { nodeId, node, success: true };
      } catch (err) {
        console.error(`[port-forward] deploy to ${node.name} failed`, err);
        return { nodeId, node, success: false, error: err };
      }
    }),
  );
  for (const r of deployResults) {
    if (r.success) {
      active.set(r.nodeId, `${TUNNEL_PREFIX}${r.nodeId}`);
    } else {
      const errs = groups.get(r.nodeId)!;
      for (const rule of errs) statuses.set(rule.id, "error");
    }
  }

  // Remove groups whose node no longer has enabled rules.
  for (const [nodeId, tunnelId] of active) {
    if (!groups.has(nodeId) && engine.has(tunnelId)) {
      await engine.remove(tunnelId);
      active.delete(nodeId);
    }
  }

  // Persist statuses.
  await Promise.all(
    [...statuses].map(([ruleId, status]) =>
      prisma.portForward.update({ where: { id: ruleId }, data: { status } }),
    ),
  );
}

export function portForwardTunnelId(nodeId: string): string {
  return `${TUNNEL_PREFIX}${nodeId}`;
}
