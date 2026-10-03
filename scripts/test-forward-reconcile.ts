/**
 * Port-forward reconcile tests (TASK-25).
 *
 * The task's note says port-forward tests already exist in
 * `scripts/test-optimizations.ts` and to extend rather than build a competing
 * harness. Those existing tests cover the *idle* and *concurrent* shapes
 * against a real (empty) database. They cannot cover the failure paths,
 * because making the deploy fail requires an injected engine, and that is not
 * possible against the live singleton.
 *
 * So this file covers what the integration harness structurally cannot, and
 * nothing that it already does:
 *   - reconcile against an INJECTED engine + database, so failure, stale-rule
 *     removal and tight-loop behaviour are observable;
 *   - the pure decision logic, which is where the state-truthfulness rule
 *     actually lives.
 *
 * No timing sleeps except where a bound genuinely must be observed.
 */
import { strict as assert } from "node:assert";

import {
  classifyRuleOutcome,
  planGroupsAndApply,
  selectForwardStatus,
  type ReconcileDeps,
} from "../apps/web/src/lib/forward-supervisor-logic.ts";

let pass = 0;
const failures: string[] = [];
const ok = (n: string): void => {
  pass += 1;
  console.log(`  ok   ${n}`);
};
const bad = (n: string, d: string): void => {
  failures.push(n);
  console.log(`  FAIL ${n}\n       ${d}`);
};

type Rule = {
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
};
type Node = { id: string; name: string; type: string };

const rule = (o: Partial<Rule> & { id: string }): Rule => ({
  name: o.id,
  direction: "IRAN_TO_FOREIGN",
  protocol: "tcp",
  sourcePort: 10000,
  destHost: "127.0.0.1",
  destPort: 80,
  enabled: true,
  nodeId: null,
  status: "pending",
  userId: "u1",
  ...o,
});

/**
 * `has` reports the engine's view of a tunnel. It now DRIVES the reported
 * status: planGroupsAndApply consults it after a successful deploy instead of
 * assuming the listener is up, so a default of `false` means "every deployed
 * rule reports error".
 *
 * The default is therefore `true` -- a healthy deploy -- and any test that is
 * specifically about a missing listener overrides it. Tests that care about
 * actual-vs-desired state say so explicitly rather than relying on a default
 * that silently flipped the assertions.
 */
const deps = (over: Partial<ReconcileDeps> = {}): ReconcileDeps => ({
  loadRules: async () => [],
  loadNodes: async () => [],
  has: () => true,
  deploy: async () => undefined,
  remove: async () => undefined,
  setStatus: async () => undefined,
  activeGroups: new Map<string, string>(),
  log: () => undefined,
  ...over,
});

async function main(): Promise<void> {
  try {
    // ---------------------------------------------------------------------
    // 0. Rule outcome classification.
    // ---------------------------------------------------------------------
    {
      const cases: Array<[string, string]> = [
        ["a port is already forwarded by another rule", "error"],
        ["ssh: connect to host 10.0.0.5 port 22: Connection refused", "error"],
        ["", "running"],
      ];
      let wrong = 0;
      for (const [err, want] of cases) {
        const got = classifyRuleOutcome(err);
        if (got !== want) {
          wrong += 1;
          bad(`classify ${JSON.stringify(err.slice(0, 28))}`, `want ${want}, got ${got}`);
        }
      }
      if (wrong === 0) ok("deploy outcomes classify into running/error");
    }

    // ---------------------------------------------------------------------
    // 1. A failed deploy is contained, then not retried in a tight loop.
    //
    // Order matters: containment is checked FIRST and on its own. If the
    // containment test runs after the retry-count test, a mutant that rethrows
    // crashes the whole suite and every later assertion is silently skipped --
    // which is exactly what mutation D did.
    // ---------------------------------------------------------------------
    {
      // Containment, in isolation: a throwing deploy must not escape.
      let escaped = false;
      let statuses: Map<string, string> = new Map();
      try {
        statuses = await planGroupsAndApply(
          deps({
            loadRules: async () => [rule({ id: "r1", nodeId: "n1" })],
            loadNodes: async () => [{ id: "n1", name: "node-a", type: "FOREIGN" }],
            deploy: async () => {
              throw new Error("node unreachable");
            },
          }),
        );
      } catch {
        escaped = true;
      }
      if (!escaped) ok("a throwing deploy is contained, not propagated");
      else bad("a throwing deploy is contained", "the reconcile threw");
      if (statuses.get("r1") === "error") ok("a contained failure is reported as error");
      else bad("a contained failure is reported as error", String(statuses.get("r1")));
    }

    // Now the retry-count behaviour.
    {
      let deploys = 0;
      const d = deps({
        loadRules: async () => [rule({ id: "r1", nodeId: "n1" })],
        loadNodes: async () => [{ id: "n1", name: "node-a", type: "FOREIGN" }],
        deploy: async () => {
          deploys += 1;
          throw new Error("node unreachable");
        },
      });
      const statuses = await planGroupsAndApply(d);
      if (deploys === 1) ok(`a failing node is deployed once per reconcile (${deploys} attempt)`);
      else bad("a failing node is deployed once per reconcile", `${deploys} attempts in one reconcile`);
      if (statuses.get("r1") === "error") ok("a failed deploy marks the rule as error");
      else bad("a failed deploy marks the rule as error", String(statuses.get("r1")));

      // Three consecutive reconciles must each attempt exactly once -- no
      // internal retry loop multiplying the attempts.
      let total = 0;
      const d2 = deps({
        loadRules: async () => [rule({ id: "r1", nodeId: "n1" })],
        loadNodes: async () => [{ id: "n1", name: "node-a", type: "FOREIGN" }],
        deploy: async () => {
          total += 1;
          throw new Error("node unreachable");
        },
      });
      for (let i = 0; i < 3; i += 1) await planGroupsAndApply(d2);
      if (total === 3) ok("three reconciles make three attempts, not a retry storm");
      else bad("three reconciles make three attempts", `${total} attempts`);
    }

    // ---------------------------------------------------------------------
    // 2. A removed/disabled rule releases its process resources.
    // ---------------------------------------------------------------------
    {
      const removed: string[] = [];
      const active = new Map<string, string>([["n1", "pf-n1"]]);
      // The rule is gone from the database, but the group is still active.
      const d = deps({
        loadRules: async () => [],
        activeGroups: active,
        has: (id) => id === "pf-n1",
        remove: async (id) => {
          removed.push(id);
        },
      });
      await planGroupsAndApply(d);
      if (removed.length === 1 && removed[0] === "pf-n1") ok("a removed rule's group is torn down");
      else bad("a removed rule's group is torn down", JSON.stringify(removed));
      if (active.size === 0) ok("the active group entry is cleared after teardown");
      else bad("the active group entry is cleared after teardown", [...active.keys()].join(","));

      // A group that is no longer running must NOT be removed again.
      const removed2: string[] = [];
      const active2 = new Map<string, string>([["n1", "pf-n1"]]);
      await planGroupsAndApply(
        deps({
          loadRules: async () => [],
          activeGroups: active2,
          has: () => false,
          remove: async (id) => removed2.push(id),
        }),
      );
      if (removed2.length === 0) ok("a group that is already stopped is not removed again");
      else bad("a group that is already stopped is not removed again", removed2.join(","));
      // The entry is still forgotten. Keeping it would grow the map for the
      // process lifetime and retry a removal that can never succeed, so a
      // no-op teardown and a real teardown both clear it.
      if (active2.size === 0) ok("an already-stopped group is forgotten too (no map leak)");
      else bad("an already-stopped group is forgotten too", [...active2.keys()].join(","));
    }

    // ---------------------------------------------------------------------
    // 3. A disabled rule is reported stopped, not silently forgotten.
    // ---------------------------------------------------------------------
    {
      const statuses = await planGroupsAndApply(
        deps({
          loadRules: async () => [rule({ id: "r1", enabled: false })],
        }),
      );
      if (statuses.get("r1") === "stopped") ok("a disabled rule is reported stopped");
      else bad("a disabled rule is reported stopped", String(statuses.get("r1")));
    }

    // ---------------------------------------------------------------------
    // 4. Forwarding state reflects reality, not just desired config.
    // ---------------------------------------------------------------------
    {
      // selectForwardStatus must be able to say "the config says enabled but
      // the listener is not there" -- reporting `running` from configuration
      // alone is the false-truthfulness the task forbids.
      if (selectForwardStatus({ enabled: true, probeOk: true }) === "running") {
        ok("a healthy probe reports running");
      } else {
        bad("a healthy probe reports running", String(selectForwardStatus({ enabled: true, probeOk: true })));
      }
      if (selectForwardStatus({ enabled: true, probeOk: false }) === "error") {
        ok("an enabled rule whose listener is missing reports error, not running");
      } else {
        bad("a missing listener reports error", String(selectForwardStatus({ enabled: true, probeOk: false })));
      }
      if (selectForwardStatus({ enabled: false, probeOk: false }) === "stopped") {
        ok("a disabled rule reports stopped regardless of the probe");
      } else {
        bad("a disabled rule reports stopped", String(selectForwardStatus({ enabled: false, probeOk: false })));
      }
      // Unknown probe result must not be reported as a healthy running.
      const unknown = selectForwardStatus({ enabled: true, probeOk: null });
      if (unknown !== "running") ok("an unknown probe result does not claim running");
      else bad("an unknown probe result does not claim running", String(unknown));
    }

    // ---------------------------------------------------------------------
    // 4b. A successful deploy is NOT reported as running when the engine says
    //     the tunnel is not actually up. This is the wiring that makes
    //     selectForwardStatus (TASK-25) reachable at all: it was exported and
    //     unit-tested but never called, so the API reported the desired state.
    // ---------------------------------------------------------------------
    {
      const healthy = await planGroupsAndApply(
        deps({
          loadRules: async () => [rule({ id: "ok", sourcePort: 10000, nodeId: "n1" })],
          loadNodes: async () => [{ id: "n1", name: "node-a", type: "FOREIGN" }],
          has: () => true,
        }),
      );
      if (healthy.get("ok") === "running") ok("a deployed rule the engine confirms reports running");
      else bad("a confirmed deploy reports running", String(healthy.get("ok")));

      // deploy() resolved, but the engine does not see the tunnel.
      const lied = await planGroupsAndApply(
        deps({
          loadRules: async () => [rule({ id: "ghost", sourcePort: 10001, nodeId: "n1" })],
          loadNodes: async () => [{ id: "n1", name: "node-a", type: "FOREIGN" }],
          has: () => false,
        }),
      );
      if (lied.get("ghost") === "error") ok("a deploy the engine cannot confirm does NOT report running");
      else bad("an unconfirmed deploy does not claim running", String(lied.get("ghost")));
    }

    // ---------------------------------------------------------------------
    // 5. Duplicate protocol+port on one node: first wins, rest report error.
    // ---------------------------------------------------------------------
    {
      let deployedRules = 0;
      const statuses = await planGroupsAndApply(
        deps({
          loadRules: async () => [
            rule({ id: "a", sourcePort: 10000, nodeId: "n1" }),
            rule({ id: "b", sourcePort: 10000, nodeId: "n1" }),
            rule({ id: "c", sourcePort: 10000, nodeId: "n1" }),
          ],
          loadNodes: async () => [{ id: "n1", name: "node-a", type: "FOREIGN" }],
          deploy: async (_id, rules) => {
            deployedRules += rules.length;
          },
        }),
      );
      if (deployedRules === 1) ok("only the first of three duplicate rules is deployed");
      else bad("only the first duplicate is deployed", `${deployedRules} deployed`);
      if (statuses.get("a") === "running" || statuses.get("a") === "pending") {
        ok("the kept duplicate is not marked error");
      } else {
        bad("the kept duplicate is not marked error", String(statuses.get("a")));
      }
      if (statuses.get("b") === "error" && statuses.get("c") === "error") {
        ok("the rejected duplicates are reported as error");
      } else {
        bad("rejected duplicates are error", `b=${statuses.get("b")} c=${statuses.get("c")}`);
      }
    }

    // ---------------------------------------------------------------------
    // 6. A rule with no resolvable node reports needs_node and is not deployed.
    // ---------------------------------------------------------------------
    {
      let deploys = 0;
      const statuses = await planGroupsAndApply(
        deps({
          loadRules: async () => [rule({ id: "r1" })],
          loadNodes: async () => [],
          deploy: async () => {
            deploys += 1;
          },
        }),
      );
      if (statuses.get("r1") === "needs_node") ok("a rule with no node reports needs_node");
      else bad("a rule with no node reports needs_node", String(statuses.get("r1")));
      if (deploys === 0) ok("a rule with no node is not deployed");
      else bad("a rule with no node is not deployed", `${deploys} deploys`);
    }

    // ---------------------------------------------------------------------
    // 7. One failing group does not strand the others.
    // ---------------------------------------------------------------------
    {
      const statuses = await planGroupsAndApply(
        deps({
          loadRules: async () => [
            rule({ id: "r1", nodeId: "n1" }),
            rule({ id: "r2", nodeId: "n2" }),
          ],
          loadNodes: async () => [
            { id: "n1", name: "node-a", type: "FOREIGN" },
            { id: "n2", name: "node-b", type: "IRAN" },
          ],
          deploy: async (id) => {
            if (id === "pf-n1") throw new Error("node-a unreachable");
          },
        }),
      );
      if (statuses.get("r1") === "error") ok("the failing group's rule reports error");
      else bad("the failing group's rule reports error", String(statuses.get("r1")));
      if (statuses.get("r2") === "running" || statuses.get("r2") === "pending") {
        ok("the healthy group's rule is still applied");
      } else {
        bad("the healthy group is still applied", String(statuses.get("r2")));
      }
    }

    // ---------------------------------------------------------------------
    // 8. Reconcile never throws for a bad group -- it reports.
    // ---------------------------------------------------------------------
    {
      let threw = false;
      try {
        await planGroupsAndApply(
          deps({
            loadRules: async () => [rule({ id: "r1", nodeId: "n1" })],
            loadNodes: async () => [{ id: "n1", name: "node-a", type: "FOREIGN" }],
            deploy: async () => {
              throw new Error("boom");
            },
            remove: async () => {
              throw new Error("remove also failed");
            },
          }),
          new Map(),
        );
      } catch {
        threw = true;
      }
      if (!threw) ok("a reconcile with failing deploy and remove does not throw");
      else bad("a reconcile with failing deploy does not throw", "it threw");
    }

    // ---------------------------------------------------------------------
    // 9. Every status set is persisted exactly once per rule.
    // ---------------------------------------------------------------------
    {
      const written: string[] = [];
      const statuses = await planGroupsAndApply(
        deps({
          loadRules: async () => [
            rule({ id: "r1", nodeId: "n1" }),
            rule({ id: "r2", nodeId: "n1" }),
            rule({ id: "r3", enabled: false }),
          ],
          loadNodes: async () => [{ id: "n1", name: "node-a", type: "FOREIGN" }],
          setStatus: async (id, s) => {
            written.push(`${id}=${s}`);
          },
        }),
      );
      if (written.length === 3) ok(`every rule gets exactly one status write (${written.length})`);
      else bad("every rule gets exactly one status write", written.join(" "));
    }

    console.log(`\n--- ${pass} passed, ${failures.length} failed ---`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    /* nothing to clean */
  }
}

void main();
assert.ok(true);
