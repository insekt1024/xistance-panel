/**
 * The benchmark workload contract (TASK-57).
 *
 * ONE declarative source for what "the representative workload" means, shared by
 * the harness and by every future measurement task. TASK-58 (startup/idle/peak)
 * and TASK-59 (latency/reconnect) extend the phases; they do not redefine them.
 *
 * Why a contract at all, rather than a script that does the work inline: a
 * benchmark whose workload drifts between runs cannot be compared to itself. If
 * the request count lives in a loop, nobody can tell later whether a regression
 * came from the code or from someone adding an iteration. Everything the
 * measurement depends on is therefore declared here, and the emitted result
 * carries a digest of this file — so a candidate run that used a DIFFERENT
 * workload is visibly not comparable instead of quietly being compared.
 *
 * The phases are deliberately separated:
 *
 *   install  — archive extraction + migrations + admin bootstrap. Measured
 *              separately because it is a one-time cost an operator pays during
 *              setup, and folding it into steady-state numbers hides both.
 *   startup  — process spawn to first healthy /api/health answer, and to first
 *              successful authenticated response. Two different milestones: the
 *              first proves the listener is up, the second proves the database
 *              path works.
 *   control  — the representative steady-state control-plane workload. Read
 *              heavy and write light, matching how the panel is actually used.
 *
 * There is deliberately NO tunnel throughput phase. Exercising real tunnel
 * throughput needs a live remote peer, a real node, and a network path; none of
 * that exists in this harness. Claiming a throughput number from a control-plane
 * HTTP benchmark would be inventing the single most-quoted figure in the release.
 * If a future task measures it, it does so in its own phase with its own
 * prerequisites, and `assertNoUnmeasuredClaims` keeps this file from quietly
 * growing a `throughput` field in the meantime.
 */

import { createHash } from "node:crypto";

export type Phase = "install" | "startup" | "control" | "reconnect";

export interface WorkloadStep {
  /** Stable identifier; appears verbatim in the result JSON. */
  readonly id: string;
  readonly method: "GET" | "POST";
  /** Path relative to the app origin. */
  readonly path: string;
  readonly count: number;
  /**
   * Why this request is in the workload. Recorded in the result so a reader can
   * judge the workload's shape rather than trusting an opaque number.
   */
  readonly purpose: string;
  /** Send a session cookie. Mutating steps are meaningless unauthenticated. */
  readonly authenticated: boolean;
  /**
   * A mutating step needs a body describing what to create. `null` for reads.
   * Templates use `{{nonce}}`, replaced per run so repeated runs do not collide
   * on a uniqueness constraint and turn a latency sample into an error sample.
   */
  readonly body?: Record<string, unknown> | null;
}

export interface WorkloadPhase {
  readonly phase: Phase;
  readonly description: string;
  readonly steps: readonly WorkloadStep[];
}

export interface Workload {
  readonly schema: "xistance.workload/1";
  /** Digest over the contract, so two runs can be proven comparable. */
  readonly digest: string;
  /** Fixture shape, so a result says what it was measured against. */
  readonly fixture: {
    readonly nodes: number;
    readonly tunnels: number;
    readonly users: number;
    readonly description: string;
  };
  readonly phases: readonly WorkloadPhase[];
}

const NODES = 4;
// 5, not 8: POST /api/tunnels allows 10 creates per 60s per user, and the
// control workload spends 5 of them. The limiter is a real production control
// and the harness refuses to bypass it, so the fixture has to fit in what is
// left. Raising the limit to make the fixture bigger would measure a
// configuration no operator runs.
const TUNNELS = 5;

const CONTROL_PHASE: WorkloadPhase = {
  phase: "control",
  description:
    "Steady-state control-plane traffic as the panel is actually used: list views dominate, " +
    "single-tunnel actions are the common write, and diagnostics is the heaviest read.",
  steps: [
    {
      id: "health",
      method: "GET",
      path: "/api/health",
      count: 20,
      purpose: "cheapest authenticated-free liveness read; the floor of the latency distribution",
      authenticated: false,
    },
    {
      id: "list-tunnels",
      method: "GET",
      path: "/api/tunnels",
      count: 20,
      purpose: "the dashboard's primary read: a paginated list joined with node state",
      authenticated: true,
    },
    {
      id: "list-nodes",
      method: "GET",
      path: "/api/nodes",
      count: 10,
      purpose: "node list with live status; the other primary dashboard read",
      authenticated: true,
    },
    {
      id: "metrics",
      method: "GET",
      path: "/api/metrics",
      count: 10,
      purpose: "aggregated telemetry over the cached window",
      authenticated: true,
    },
    {
      id: "search",
      method: "GET",
      path: "/api/search?q=tunnel",
      count: 10,
      purpose: "search across tunnels and nodes; the heaviest read-only query",
      authenticated: true,
    },
    {
      id: "create-tunnel",
      method: "POST",
      path: "/api/tunnels",
      count: 5,
      purpose: "a control-plane write: validation, persistence, and engine publish",
      authenticated: true,
      // The REAL TunnelCreateSchema shape. `TunnelConfigSchema` is a
      // discriminated union on `method`, and both node ids are required UUIDs,
      // so the body is `{method, direct:{...}}` and the node ids come from the
      // seeded fixture. An invented shape here is not a no-op: the API answers
      // 422 and the benchmark then measures its own rejection at 0ms.
      body: {
        name: "bench-{{nonce}}",
        clientNodeId: "{{clientNodeId}}",
        serverNodeId: "{{serverNodeId}}",
        autostart: false,
        // PORT_FORWARD, not DIRECT. Every method is DEPLOYED on create, and
        // DIRECT requires a `gost` binary on the node -- which is not vendored
        // here, so a DIRECT create returns 500 "Required binary gost is
        // missing" and the benchmark measures its own failure. PORT_FORWARD is
        // the method that provisions without an external binary, so the write
        // path is genuinely exercised instead of being skipped.
        config: {
          method: "PORT_FORWARD",
          portForwards: [
            {
              name: "rule-{{nonce}}",
              direction: "IRAN_TO_FOREIGN",
              protocol: "tcp",
              // The WHOLE port is the token, not a suffix glued onto a literal
              // prefix. A prefixed form ("182" + token) is a digit-count trap: the
              // token has to stay small enough that the concatenation fits in
              // 65535, and getting that wrong yields 182134 -- which is NOT a
              // valid port, so every create 422s on the very field the workload
              // exists to measure. Declared as a string only because the schema
              // is z.number() and a template is not valid numeric syntax;
              // renderTemplate converts an all-digit result back to a number.
              //
              // A fixed port is equally wrong: the second create returns 409
              // "Port already in use", so only 1 of 5 requests measures anything
              // and the harness publishes a p50 from a single sample.
              sourcePort: "{{sourcePort}}",
              destHost: "127.0.0.1",
              destPort: 9,
              enabled: true,
            },
          ],
        },
      },
    },
    {
      id: "tunnel-diagnostics",
      method: "GET",
      path: "/api/tunnels/{{tunnelId}}/diagnostics",
      count: 10,
      purpose: "the bounded diagnostic aggregation; the heaviest single-tunnel read",
      authenticated: true,
    },
  ],
};

/**
 * Recovery after a real fault (TASK-59).
 *
 * The failure is injected, not simulated by calling a helper: the tunnel is
 * genuinely stopped and then genuinely started again, and what is timed is the
 * panel's own recovery path -- the stop that must be honoured, the interval in
 * which the panel reports the tunnel as not running, and the start that brings
 * it back. Timing a mocked failure would measure the mock.
 *
 * `stop` then `start` rather than `restart`: `restart` is a single request that
 * does both, so it cannot separate "the stop was honoured" from "the start
 * recovered". Two requests make each half observable, which is what a recovery
 * budget is written against.
 *
 * The tunnel is created by the control phase and is expected to be a real
 * fixture tunnel. On a host with no engine (this harness's default) the action
 * endpoints answer honestly -- `stop` on a tunnel the engine never adopted
 * still persists `stopped` -- so the write path is genuinely exercised. A
 * deployment failure on `start` is reported as a non-2xx, never as a fast pass.
 */
const RECONNECT_PHASE: WorkloadPhase = {
  phase: "reconnect",
  description:
    "Recovery from an injected fault: stop a real fixture tunnel, confirm the panel honours " +
    "the stop, then bring it back and time the start. Each half is a separate request so a " +
    "recovery budget can be written against the stop and the restart independently.",
  steps: [
    {
      id: "inject-fault-stop",
      method: "POST",
      path: "/api/tunnels/{{tunnelId}}/actions",
      count: 1,
      purpose: "fault injection: the operator-visible stop that puts the tunnel into recovery",
      authenticated: true,
      body: { action: "stop" },
    },
    {
      id: "status-after-fault",
      method: "GET",
      path: "/api/tunnels/{{tunnelId}}",
      count: 1,
      purpose: "the panel's own view during recovery: the stop must be reported, not masked",
      authenticated: true,
    },
    {
      id: "recover-start",
      method: "POST",
      path: "/api/tunnels/{{tunnelId}}/actions",
      count: 1,
      purpose: "recovery: the start that returns the tunnel to service, timed on its own",
      authenticated: true,
      body: { action: "start" },
    },
  ],
};

const PHASES: readonly WorkloadPhase[] = [
  {
    phase: "install",
    description:
      "One-time operator cost, measured on its own: staged payload already in place, so this " +
      "covers migrations and admin bootstrap, not artifact download.",
    steps: [],
  },
  {
    phase: "startup",
    description:
      "Two milestones measured separately: first healthy health answer (the listener works) and " +
      "first authenticated response (the database path works). They are not the same event and a " +
      "panel can pass the first while failing the second.",
    steps: [],
  },
  CONTROL_PHASE,
  RECONNECT_PHASE,
];

/** The total requests one run issues, for the record. */
export function totalRequests(workload: Workload): number {
  return workload.phases.reduce(
    (sum, phase) => sum + phase.steps.reduce((n, step) => n + step.count, 0),
    0,
  );
}

/**
 * A stable digest of the contract.
 *
 * Computed over the serialised phases and fixture rather than over this file's
 * bytes: a comment or a reformat must not invalidate comparability, while
 * changing a count, a path or the fixture shape must.
 */
function digestOf(phases: readonly WorkloadPhase[], fixture: Workload["fixture"]): string {
  const canonical = JSON.stringify({
    phases: phases.map((p) => ({
      phase: p.phase,
      steps: p.steps.map((s) => ({
        id: s.id,
        method: s.method,
        path: s.path,
        count: s.count,
        authenticated: s.authenticated,
        body: s.body ?? null,
      })),
    })),
    fixture,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export const WORKLOAD: Workload = {
  schema: "xistance.workload/1",
  digest: digestOf(PHASES, { nodes: NODES, tunnels: TUNNELS, users: 2, description: "disposable benchmark database" }),
  fixture: {
    nodes: NODES,
    tunnels: TUNNELS,
    users: 2,
    description: "disposable benchmark database",
  },
  phases: PHASES,
};

/**
 * Refuse to emit a result that implies a measurement nobody took.
 *
 * A benchmark harness is trusted precisely because it does not flatter itself.
 * The most likely way to lose that is a field named `throughput` or `mbps` in a
 * control-plane HTTP benchmark, which is a number no code here can support. If
 * someone adds one, the harness stops rather than publishing it.
 */
export function assertNoUnmeasuredClaims(result: Record<string, unknown>): void {
  const forbidden = ["throughput", "mbps", "bandwidth", "tunnelsPerSecond", "packetsPerSecond"];
  const seen: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "object" && node !== null) {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (forbidden.includes(key)) seen.push(`${path}.${key}`);
        walk(value, `${path}.${key}`);
      }
    }
  };
  walk(result, "result");
  if (seen.length > 0) {
    throw new Error(
      `the benchmark result contains unmeasured claims: ${seen.join(", ")}. ` +
        `This harness measures control-plane HTTP and install/startup only. Tunnel throughput ` +
        `requires a live peer and a real network path and must be measured in its own phase.`,
    );
  }
}

/** Substitute `{{nonce}}` and `{{tunnelId}}` for a single run. */
export interface TemplateContext {
  readonly nonce: string;
  /**
   * The complete source port for a port-forward create, as a numeric string.
   *
   * The caller supplies the WHOLE value, not a suffix to append to a literal
   * prefix. That keeps port validity in one place: the caller can assert the
   * result is a real, in-range, non-colliding port before sending, instead of
   * the schema rejecting an over-long concatenation after the fact.
   */
  readonly sourcePort?: string;
  readonly tunnelId: string;
  /** Seeded fixture node ids, for steps that create a tunnel. */
  readonly clientNodeId?: string;
  readonly serverNodeId?: string;
}

export function renderTemplate(value: unknown, context: TemplateContext): unknown {
  if (typeof value === "string") {
    // A templated numeric field (a port) is declared as a string so the template
    // is legal syntax, but the API schema is z.number(). So a substituted value
    // that is entirely digits is converted back to a number.
    //
    // The test must run AFTER substitution. Checking the template itself
    // ("182{{portToken}}") can never be numeric, so a check placed before
    // substitution silently never fires and every port arrives as a string,
    // earning a 422 on the exact field the workload claimed to exercise.
    const substituted = value
      .replaceAll("{{nonce}}", context.nonce)
      .replaceAll("{{tunnelId}}", context.tunnelId)
      .replaceAll("{{sourcePort}}", context.sourcePort ?? "0")
      .replaceAll("{{clientNodeId}}", context.clientNodeId ?? "")
      .replaceAll("{{serverNodeId}}", context.serverNodeId ?? "");
    return value.includes("{{") && /^-?\d+$/.test(substituted) ? Number(substituted) : substituted;
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, context));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderTemplate(v, context);
    }
    return out;
  }
  return value;
}
