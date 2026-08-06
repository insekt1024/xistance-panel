import { prisma, type PortForward as DbPortForward, type Node as DbNode } from "@xistance/db";
import { getEngine } from "./engine";
import { buildSpec } from "./tunnels";
import type { PortForwardRule } from "@xistance/types";

// ---------------------------------------------------------------------------
// Port-forward supervisor. Reconciles the enabled rules from the database with
// engine-managed processes (one synthetic PORT_FORWARD tunnel per target node).
// - Rules whose listener node is the panel host run the in-process worker.
// - Rules on a remote node run a gost-forward systemd unit there.
// Call after any CRUD change and on server boot.
// ---------------------------------------------------------------------------

const TUNNEL_PREFIX = "pf-";

const active = new Map<string, string>(); // nodeId -> engine tunnel id

function toRule(r: DbPortForward): PortForwardRule {
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

async function resolveTargetNode(
  rule: DbPortForward,
  nodes: DbNode[],
): Promise<DbNode | null> {
  if (rule.nodeId) return nodes.find((n) => n.id === rule.nodeId) ?? null;
  const byType = nodes.filter(
    (n) => n.type === (rule.direction === "IRAN_TO_FOREIGN" ? "IRAN" : "FOREIGN"),
  );
  return byType.length === 1 ? byType[0] : null;
}

export async function reconcilePortForwards(): Promise<void> {
  const engine = getEngine();
  const [rules, nodes] = await Promise.all([
    prisma.portForward.findMany(),
    prisma.node.findMany(),
  ]);
  const enabled = rules.filter((r) => r.enabled);

  // Group enabled rules by resolved target node.
  const groups = new Map<string, DbPortForward[]>();
  const statuses = new Map<string, string>(); // ruleId -> status
  for (const rule of enabled) {
    const node = await resolveTargetNode(rule, nodes);
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

  // Deploy/replace one PORT_FORWARD tunnel per node group.
  for (const [nodeId, nodeRules] of groups) {
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
      if (engine.has(tunnelId)) {
        await engine.restart(tunnelId);
      } else {
        await engine.deploy(spec);
      }
      active.set(nodeId, tunnelId);
    } catch (err) {
      console.error(`[port-forward] deploy to ${node.name} failed`, err);
      for (const r of nodeRules) statuses.set(r.id, "error");
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
