/**
 * Port-forward reconcile decision logic (TASK-25).
 *
 * The supervisor's reconcile used to be one function that read the database,
 * deployed, removed, and wrote statuses -- so every failure path in it was
 * unreachable from a test without a live engine and a live database. This
 * module holds the decisions, with the I/O injected, and the supervisor
 * supplies the real implementations.
 *
 * Design constraints:
 *  - no tight retry loop. A failing node is attempted ONCE per reconcile; a
 *    storm is prevented by the caller's cadence, not by hidden retries here,
 *    because a hidden retry would multiply an already-30s SSH timeout.
 *  - a reconcile never throws for a per-group failure. It reports the failure
 *    into the rule's status, because throwing would abandon every other rule
 *    unreported.
 *  - state reflects reality. A rule whose listener is not actually up is
 *    reported as error even when the desired configuration says enabled.
 */

export interface ReconcileRule {
  id: string;
  name: string;
  direction: string;
  protocol: string;
  sourcePort: number;
  destHost: string;
  destPort: number;
  enabled: boolean;
  nodeId: string | null;
  status: string;
  userId: string;
}

export interface ReconcileNode {
  id: string;
  name: string;
  type: string;
}

export interface ReconcileDeps {
  loadRules(): Promise<ReconcileRule[]>;
  loadNodes(): Promise<ReconcileNode[]>;
  /** Is a tunnel currently deployed/running under this id? */
  has(tunnelId: string): boolean;
  /** Deploy the given rules as one tunnel. May throw. */
  deploy(tunnelId: string, rules: ReconcileRule[]): Promise<void>;
  /** Tear down a tunnel. May throw. */
  remove(tunnelId: string): Promise<void>;
  setStatus(ruleId: string, status: string): Promise<void>;
  /** nodeId -> tunnelId, mutated in place. */
  activeGroups: Map<string, string>;
  log(message: string, err?: unknown): void;
}

/** Map a deploy failure onto the status vocabulary. */
export function classifyRuleOutcome(error: unknown): "running" | "error" {
  if (!error) return "running";
  return "error";
}

/**
 * The status a rule should report.
 *
 * `probeOk === null` means the listener state is UNKNOWN. Reporting `running`
 * for an unknown state is exactly the false reassurance this exists to prevent,
 * so unknown is treated as not-running.
 */
export function selectForwardStatus(input: {
  enabled: boolean;
  probeOk: boolean | null;
}): "running" | "stopped" | "error" {
  if (!input.enabled) return "stopped";
  if (input.probeOk === true) return "running";
  return "error";
}

export interface GroupPlan {
  nodeId: string;
  tunnelId: string;
  rules: ReconcileRule[];
}

/**
 * Decide which rules belong to which node group, and which are duplicates.
 *
 * Duplicate protocol+port on one node is a real hazard: the two rules would
 * share a systemd unit name and the second bind would fail the whole group
 * deploy, taking the healthy rules down with it. The first is kept and the rest
 * are reported as errors.
 */
export function planGroups(
  rules: ReconcileRule[],
  nodes: ReconcileNode[],
): { groups: Map<string, GroupPlan>; statuses: Map<string, string> } {
  const statuses = new Map<string, string>();
  const groups = new Map<string, GroupPlan>();

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const byType = (type: string): ReconcileNode[] =>
    nodes.filter((n) => n.type === type);

  for (const rule of rules) {
    if (!rule.enabled) {
      statuses.set(rule.id, "stopped");
      continue;
    }
    const node = rule.nodeId
      ? byId.get(rule.nodeId) ?? null
      : // Auto-created rules always pin nodeId; this fallback only serves
        // legacy rows. Pick the first candidate rather than leaving the rule
        // in a permanent needs_node dead-end.
        (byType(rule.direction === "IRAN_TO_FOREIGN" ? "IRAN" : "FOREIGN")[0] ?? null);
    if (!node) {
      statuses.set(rule.id, "needs_node");
      continue;
    }
    const key = `${rule.protocol}:${rule.sourcePort}`;
    const existing = groups.get(node.id);
    if (existing) {
      if (existing.rules.some((r) => `${r.protocol}:${r.sourcePort}` === key)) {
        statuses.set(rule.id, "error");
        continue;
      }
      existing.rules.push(rule);
    } else {
      groups.set(node.id, { nodeId: node.id, tunnelId: `pf-${node.id}`, rules: [rule] });
    }
  }
  return { groups, statuses };
}

/**
 * Run one reconcile pass. Never throws for a per-group failure.
 *
 * Ordering matters: groups are deployed first so that a newly-enabled rule
 * starts before stale groups are torn down, and teardown only touches groups
 * that are still actually running.
 */
export async function planGroupsAndApply(
  deps: ReconcileDeps,
): Promise<Map<string, string>> {
  const [rules, nodes] = await Promise.all([deps.loadRules(), deps.loadNodes()]);
  const { groups, statuses } = planGroups(rules, nodes);

  // Deploy each group exactly once. Parallel across groups: they are
  // independent nodes, and serialising them would make N slow nodes take
  // N x 30s.
  const results = await Promise.all(
    [...groups.values()].map(async (plan) => {
      try {
        await deps.deploy(plan.tunnelId, plan.rules);
        return { plan, error: null as unknown };
      } catch (err) {
        // Log with the error, but the status written below is sanitised.
        deps.log(`deploy to ${plan.nodeId} failed`, err);
        return { plan, error: err };
      }
    }),
  );

  for (const { plan, error } of results) {
    if (error) {
      for (const r of plan.rules) statuses.set(r.id, "error");
      continue;
    }
    deps.activeGroups.set(plan.nodeId, plan.tunnelId);
    // A resolved deploy is NOT proof the listener is up. Confirm against the
    // engine's own view before reporting "running": a deploy can return while
    // the process dies immediately, and the UI would then show a tunnel that
    // is not forwarding. selectForwardStatus treats an unknown probe as
    // not-running, so a failed lookup reports "error" rather than false
    // reassurance.
    for (const r of plan.rules) {
      statuses.set(
        r.id,
        selectForwardStatus({ enabled: r.enabled, probeOk: deps.has(plan.tunnelId) }),
      );
    }
  }

  // Tear down groups whose node no longer has enabled rules. `has` guards
  // against removing something that is not running, which would be a pointless
  // remote operation on every reconcile.
  for (const [nodeId, tunnelId] of [...deps.activeGroups.entries()]) {
    if (groups.has(nodeId)) continue;
    try {
      if (deps.has(tunnelId)) await deps.remove(tunnelId);
    } catch (err) {
      deps.log(`remove of ${tunnelId} failed`, err);
    } finally {
      // Always forget it, even if the teardown failed. Keeping a stale entry
      // means the map grows for the process lifetime and every subsequent
      // reconcile retries a removal that may never succeed.
      deps.activeGroups.delete(nodeId);
    }
  }

  // Persist statuses. One failing write must not abandon the others.
  await Promise.allSettled(
    [...statuses].map(([ruleId, status]) => deps.setStatus(ruleId, status)),
  );

  return statuses;
}
