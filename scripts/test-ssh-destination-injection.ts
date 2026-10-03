/**
 * SSH destination-token injection (node path) and the X-UI panel-probe policy.
 *
 * The vulnerability, verified by execution rather than by reading:
 *
 *   1. `NodeConfigSchema` validated `username` as `z.string().min(1)`, so
 *      `username: "-oProxyCommand=touch /tmp/pwn"` was accepted and stored.
 *   2. Both `app/api/nodes/[id]/test/route.ts` and `RemoteRunner.baseArgs`
 *      splice it into the argv token `${username}@${host}`.
 *   3. ssh parses ANY argv token beginning with "-" as an OPTION before it
 *      looks for a destination. Running the local OpenSSH with such a token
 *      executed the ProxyCommand on this host — a marker file appeared.
 *
 * The SSH-tunnel path already refused this (`assertSafeSshDestination` and the
 * `SshConfigSchema` / `ReverseConfigSchema` regexes). The NODE path was the one
 * caller that bypassed them, which is the actual shape of the bug: a fix that
 * lives in a validator only protects callers that use the validator.
 *
 * Run: npx tsx scripts/test-ssh-destination-injection.ts
 */

import fs from "node:fs";
import path from "node:path";

import { NodeConfigSchema, SshConfigSchema } from "../packages/types/src/index";
import { assertSafeSshDestination } from "../packages/tunnel-core/src/config/ssh";
import { rejectPanelProbeHost } from "../apps/web/src/lib/panel-probe-host";

const REPO = path.resolve(import.meta.dirname, "..");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, detail = ""): void {
  passed++;
  console.log(`  ok   ${name}${detail ? ` (${detail})` : ""}`);
}
function bad(name: string, detail = ""): void {
  failed++;
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
}
function expect(cond: boolean, name: string, detail = ""): void {
  if (cond) ok(name);
  else bad(name, detail);
}

const NODE_BASE = { name: "n", type: "IRAN", port: 22, authMethod: "key" } as const;

async function main(): Promise<void> {
  console.log("\n--- NodeConfigSchema refuses an ssh option as a username ---");
  // The exact payload class from the report.
  const payloads: [string, string, Record<string, unknown>][] = [
    ["username", "-oProxyCommand=touch /tmp/pwn", { ...NODE_BASE, host: "10.0.0.1", username: "-oProxyCommand=touch /tmp/pwn" }],
    ["username (short)", "-oV", { ...NODE_BASE, host: "10.0.0.1", username: "-oV" }],
    ["username with @", "root@evil", { ...NODE_BASE, host: "10.0.0.1", username: "root@evil" }],
    ["username with space", "root -oProxyCommand=x", { ...NODE_BASE, host: "10.0.0.1", username: "root -oProxyCommand=x" }],
    ["username with ;", "root;id", { ...NODE_BASE, host: "10.0.0.1", username: "root;id" }],
    ["host starting with -", "-oProxyCommand=x", { ...NODE_BASE, host: "-oProxyCommand=x", username: "root" }],
    ["host with space", "10.0.0.1 -oProxyCommand=x", { ...NODE_BASE, host: "10.0.0.1 -oProxyCommand=x", username: "root" }],
    ["host with newline", "10.0.0.1\nid", { ...NODE_BASE, host: "10.0.0.1\nid", username: "root" }],
  ];
  let anyAccepted = 0;
  for (const [label, value, input] of payloads) {
    const r = NodeConfigSchema.safeParse(input);
    if (r.success) {
      anyAccepted++;
      bad(`NodeConfigSchema rejects a hostile ${label}`, `accepted ${JSON.stringify(value)}`);
    } else {
      ok(`NodeConfigSchema rejects a hostile ${label}`);
    }
  }
  // The vacuous-`ok()` trap: one summary line that passes unconditionally.
  expect(
    anyAccepted === 0,
    "no hostile node username or host is accepted at all",
    `${anyAccepted} of ${payloads.length} got through`,
  );

  console.log("\n--- and it still accepts real values ---");
  for (const [label, input] of [
    ["root@10.0.0.1", { ...NODE_BASE, host: "10.0.0.1", username: "root" }],
    ["deploy@panel.example.com", { ...NODE_BASE, host: "panel.example.com", username: "deploy" }],
    ["dotted user + IPv6 host", { ...NODE_BASE, host: "2001:db8::1", username: "ops.user" }],
  ] as const) {
    const r = NodeConfigSchema.safeParse(input);
    expect(r.success, `NodeConfigSchema accepts a real destination (${label})`, r.success ? "" : r.error.issues[0]?.message);
  }

  console.log("\n--- assertSafeSshDestination is the single source of truth ---");
  // The two schemas and the runtime check must agree, or a value can pass one
  // and fail the other. A mismatch is a real bug even though no test fails.
  const cases: [string, string][] = [
    ["root", "10.0.0.1"],
    ["ops.user", "panel.example.com"],
    ["-oProxyCommand=x", "10.0.0.1"],
    ["root", "-oProxyCommand=x"],
    ["root x", "10.0.0.1"],
  ];
  let mismatches = 0;
  for (const [username, host] of cases) {
    const runtimeOk = (() => {
      try {
        assertSafeSshDestination(username, host);
        return true;
      } catch {
        return false;
      }
    })();
    const schemaOk = NodeConfigSchema.safeParse({ ...NODE_BASE, host, username }).success;
    if (runtimeOk !== schemaOk) {
      mismatches++;
      bad(`schema and runtime agree on ${JSON.stringify(`${username}@${host}`)}`, `schema=${schemaOk} runtime=${runtimeOk}`);
    } else {
      ok(`schema and runtime agree on ${JSON.stringify(`${username}@${host}`)} (${runtimeOk ? "allow" : "refuse"})`);
    }
  }
  expect(mismatches === 0, "the schema and the runtime check never disagree", `${mismatches} mismatches`);

  // The SSH-tunnel schema must not have regressed while NodeConfigSchema was
  // changed — it is the caller that was already safe.
  const sshProbe = SshConfigSchema.safeParse({
    mode: "local", host: "10.0.0.1", localPort: 1, remoteHost: "10.0.0.2", remotePort: 2,
    username: "-oProxyCommand=x",
  });
  expect(!sshProbe.success, "SshConfigSchema still refuses the payload (no regression)");

  console.log("\n--- both argv construction sites re-check at the point of use ---");
  const testRoute = fs.readFileSync(
    path.join(REPO, "apps/web/app/api/nodes/[id]/test/route.ts"), "utf8",
  );
  const runner = fs.readFileSync(path.join(REPO, "packages/tunnel-core/src/runner.ts"), "utf8");

  // Schema-only protection is not enough: a node row stored before the fix is
  // still in the database, and any caller can build an SshConnection directly.
  expect(
    /assertSafeSshDestination\(sshUsername, ep\.host\)/.test(testRoute),
    "the node test route validates the destination before building argv",
  );
  // ...and it must happen BEFORE the token is pushed, or it is theatre.
  const routeGuard = testRoute.indexOf("assertSafeSshDestination(sshUsername, ep.host)");
  const routePush = testRoute.indexOf("args.push(`${sshUsername}@${ep.host}`");
  expect(
    routeGuard > 0 && routePush > routeGuard,
    "the node test route validates before pushing the destination token",
    `guard at ${routeGuard}, push at ${routePush}`,
  );
  expect(
    /assertSafeSshDestination\(this\.conn\.username, this\.conn\.host\)/.test(runner),
    "RemoteRunner.baseArgs validates the destination it builds",
  );
  const runnerGuard = runner.indexOf("assertSafeSshDestination(this.conn.username");
  const runnerPush = runner.indexOf("`${this.conn.username}@${this.conn.host}`");
  expect(
    runnerGuard > 0 && runnerPush > runnerGuard,
    "RemoteRunner validates before building the destination token",
    `guard at ${runnerGuard}, token at ${runnerPush}`,
  );

  console.log("\n--- raw ssh stderr is not persisted unredacted ---");
  expect(
    /sanitizeForDiagnostics\(res\.stderr/.test(testRoute),
    "the node test log line runs stderr through sanitizeForDiagnostics",
  );
  expect(
    !/console\.warn\([^)]*\$\{res\.stderr\.trim\(\)\.slice/.test(testRoute),
    "no raw res.stderr is interpolated into the log line",
  );

  console.log("\n--- the X-UI probe policy: private yes, loopback/metadata no ---");
  // The feature's purpose: a 3X-UI panel on the user's own private VPS.
  for (const host of ["10.0.0.5", "192.168.1.10", "172.16.0.1", "panel.example.com", "100.64.0.1"]) {
    expect(rejectPanelProbeHost(host) === null, `X-UI probe still reaches a private target (${host})`, rejectPanelProbeHost(host) ?? "");
  }
  for (const [host, why] of [
    ["127.0.0.1", "panel loopback"],
    ["127.0.0.53", "any loopback"],
    ["[::1]", "IPv6 loopback"],
    ["[::ffff:127.0.0.1]", "IPv4-mapped loopback"],
    ["169.254.169.254", "cloud metadata"],
    ["[fe80::1]", "IPv6 link-local"],
    ["0.0.0.0", "unspecified"],
  ] as const) {
    expect(rejectPanelProbeHost(host) !== null, `X-UI probe refuses ${host} (${why})`);
  }

  console.log(`\n--- ${passed} passed, ${failed} failed ---`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
