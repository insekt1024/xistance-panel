import { prisma, type PortForward as DbPortForward, type Node as DbNode } from "@xistance/db";
import { getEngine } from "./engine";
import { coalescer } from "@xistance/tunnel-core";
import {
  planGroupsAndApply,
  type ReconcileNode,
  type ReconcileRule,
} from "./forward-supervisor-logic";
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

/**
 * One reconcile pass.
 *
 * All decisions live in forward-supervisor-logic.ts with the I/O injected, so
 * the failure paths (deploy throws, teardown throws, duplicates, needs_node)
 * are reachable from a test. This function only supplies the real engine and
 * database and translates rule rows into the planner's shape.
 */
export async function reconcilePortForwards(): Promise<void> {
  const engine = getEngine();
  const nodes = (await getNodes()) as unknown as ReconcileNode[];

  await planGroupsAndApply({
    loadRules: () =>
      prisma.portForward.findMany({
        select: {
          id: true, name: true, direction: true, protocol: true, sourcePort: true,
          destHost: true, destPort: true, enabled: true, nodeId: true, status: true, userId: true,
        },
      }) as Promise<ReconcileRule[]>,
    loadNodes: async () => nodes,
    has: (tunnelId) => engine.has(tunnelId),
    deploy: async (tunnelId, rules) => {
      const nodeId = tunnelId.slice(TUNNEL_PREFIX.length);
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) throw new Error(`node ${nodeId} is no longer available`);
      // Always go through the deploy path: engine.restart() only restarts the
      // existing processes and never rewrites rules.json, so rule edits would
      // never take effect. deploy() rewrites the files AND disposes the
      // predecessor runtime first (see TunnelEngine.deploy).
      const spec = await buildSpec(
        tunnelId,
        `Port-forward (${node.name})`,
        "PORT_FORWARD",
        {
          method: "PORT_FORWARD",
          portForwards: rules.map(toRule),
        },
        node.type === "IRAN" ? (node as never) : null,
        node.type === "FOREIGN" ? (node as never) : null,
      );
      await engine.deploy(spec);
    },
    remove: (tunnelId) => engine.remove(tunnelId),
    setStatus: async (ruleId, status) => {
      // Resolve to void: the planner only needs the write to have happened, and
      // returning the row made the dependency signature `Promise<PortForward>`,
      // which is not assignable to `Promise<void>`.
      await prisma.portForward.update({ where: { id: ruleId }, data: { status } });
    },
    activeGroups: active,
    log: (message, err) => console.error(`[port-forward] ${message}`, err),
  });
}

// ---------------------------------------------------------------------------
// Request-facing reconcile.
//
// reconcilePortForwards() deploys to the target node, and a node that is slow
// or unreachable costs the full SSH timeout (runner.ts DEFAULT_TIMEOUT, 30s).
// The create/update/delete routes used to await it directly, so a single
// unreachable node froze the browser for 30 seconds on every rule change —
// measured at 30.1s. Cross-border links drop often enough that this is the
// normal case, not the edge case.
//
// Concurrent callers share one run, and a change that lands mid-run schedules
// exactly one follow-up so the last write still gets applied.
// ---------------------------------------------------------------------------

// Coalescing is delegated to the shared helper (TASK-23) rather than
// reimplemented here. The behavioural difference that matters: a caller
// arriving mid-run now JOINS the run instead of flagging a follow-up, so N
// concurrent callers cause 1 run rather than N+1. `scheduleFollowUp` is
// reserved for the case that genuinely needs a second pass -- a rule write that
// landed after the in-flight run had already read the database.
const runReconcile = coalescer<void>(
  () => reconcilePortForwards(),
  (err) => {
    console.error("[port-forward] follow-up reconcile failed:", err);
  },
);

/**
 * Apply rule changes without hanging the request.
 *
 * A healthy node reconciles in milliseconds, so the caller still sees the
 * final state — behaviour is unchanged on a working setup. Past `graceMs` we
 * stop waiting and let the deploy finish in the background; the rule's
 * `status` column carries the outcome and the dashboard's 30s refresh picks
 * it up.
 *
 * @returns true if the reconcile completed within the grace period.
 */
export async function reconcilePortForwardsSoon(graceMs = 3_000): Promise<boolean> {
  const run = runReconcile();
  // Attaching the rejection handler here also keeps a background failure from
  // surfacing as an unhandled rejection once we stop awaiting.
  const done = run.then(
    () => true,
    (err) => {
      console.error("[port-forward] reconcile failed:", err);
      return true;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), graceMs);
    timer.unref?.();
  });
  const finished = await Promise.race([done, expired]);
  if (timer) clearTimeout(timer);
  return finished;
}

export function portForwardTunnelId(nodeId: string): string {
  return `${TUNNEL_PREFIX}${nodeId}`;
}
