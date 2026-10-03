/**
 * SSRF and private-network probe protection (TASK-42).
 *
 * Every case here is a REAL bypass, not a theoretical one. Each was reproduced
 * against the guard as it stood before this task:
 *
 *   - `isPrivateIp` returned `false` for EVERY IPv4-mapped IPv6 form
 *     (`::ffff:127.0.0.1`, `::ffff:10.0.0.1`, `::ffff:169.254.169.254`) and for
 *     the Alibaba metadata address `100.100.100.200`, CGNAT `100.64.0.1`,
 *     broadcast `255.255.255.255`, multicast `224.0.0.1` and `240.0.0.1`.
 *   - `new URL("http://[::ffff:127.0.0.1]/").hostname` is the BRACKETED string
 *     `[::ffff:7f00:1]`, and `net.isIP` returns 0 for a bracketed literal, so the
 *     literal branch never ran and the host fell through to a DNS lookup.
 *   - The `latency` tool passed the caller-supplied host straight into
 *     `ping -c 4 -W 3 <host>` as a bare argv element. A host of `-f127.0.0.1`
 *     passed `isBlockedTarget` (not an IP, not a known name) and became a ping
 *     FLAG rather than a target.
 *
 * The suite also pins the boundaries that must NOT move: public addresses stay
 * allowed, the XUI exception stays scoped to the XUI route, and the node-test
 * route's own error text is sanitised.
 *
 * Run: npx tsx scripts/test-ssrf-guard.ts
 */

import net from "node:net";
import fs from "node:fs";
import path from "node:path";

import {
  isPrivateIp,
  isBlockedTarget,
  describeAddress,
  unbracketForTest,
  isUnresolvableName,
  looksLikeFlag,
} from "../apps/web/src/lib/ssrf";
import { rejectForwardHost } from "../apps/web/src/lib/forward-host";

const REPO = path.resolve(import.meta.dirname, "..");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, detail = ""): void {
  passed++;
  console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
}

function bad(name: string, detail: string): void {
  failed++;
  failures.push(`${name}: ${detail}`);
  console.log(`  FAIL ${name} — ${detail}`);
}

function expectBlocked(name: string, host: string): void {
  isBlockedTarget(host).then(
    (blocked) => {
      if (blocked) ok(name);
      else bad(name, `${host} was ALLOWED`);
    },
    (e: unknown) => bad(name, `threw: ${String(e).slice(0, 90)}`),
  );
}

async function main(): Promise<void> {
  /* ==================================================================== */
  console.log("\n--- IPv4 literal ranges (WCAG of the network, RFC 1918 + more) ---");
  // Before this task every one of these returned false.
  const MUST_BLOCK_V4 = [
    "127.0.0.1", "127.1.2.3", "10.0.0.1", "10.255.255.254",
    "172.16.0.1", "172.31.255.254", "192.168.1.1",
    "169.254.169.254", "0.0.0.0", "0.1.2.3",
    // The gaps this task closed:
    "100.100.100.200", // Alibaba Cloud instance metadata
    "100.64.0.1", "100.127.255.254", // CGNAT / shared address space
    "192.0.0.1", "192.0.2.1", // IETF protocol assignments
    "198.18.0.1", "198.19.255.254", // benchmarking
    "198.51.100.1", // TEST-NET-2
    "203.0.113.1", // TEST-NET-3
    "224.0.0.1", "239.255.255.250", // multicast + SSDP
    "240.0.0.1", "255.255.255.255", // reserved + broadcast
    "255.255.255.254",
  ];
  for (const ip of MUST_BLOCK_V4) {
    const blocked = isPrivateIp(ip);
    if (blocked) ok(`blocks ${ip}`);
    else bad(`blocks ${ip}`, "isPrivateIp returned false");
  }

  console.log("\n--- IPv6 literals, including IPv4-mapped forms ---");
  const MUST_BLOCK_V6 = [
    "::1", "::", "fe80::1", "fe80::abcd:1234", "fc00::1", "fd12:3456::1",
    // The canonical SSRF bypass, previously ALL false:
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "::ffff:192.168.1.1", "::ffff:100.100.100.200", "::ffff:0.0.0.0",
    // Same address written in the other legal forms:
    "0:0:0:0:0:ffff:7f00:1", "::FFFF:7F00:1", "::ffff:7f00:0001",
    // IPv4-compatible (deprecated but still routable by some stacks):
    "::127.0.0.1", "::10.0.0.1",
    // 6to4 embedding a private v4 in the next field:
    "2002:7f00:1::", "2002:a00:1::",
    // NAT64 well-known prefix embedding 127.0.0.1:
    "64:ff9b::7f00:1", "64:ff9b::a00:1",
    // Teredo (2001:0000::/32) and 6bone
    "2001::1", "2001:db8::1", "3ffe::1",
    // Multicast + link-local scoped
    "ff00::1", "ff02::1", "ff05::1",
    // Unspecified / discard
    "100::1", "2001:2::1",
  ];
  for (const ip of MUST_BLOCK_V6) {
    const blocked = isPrivateIp(ip);
    if (blocked) ok(`blocks ${ip}`);
    else bad(`blocks ${ip}`, "isPrivateIp returned false");
  }

  console.log("\n--- PUBLIC addresses must stay allowed (no over-blocking) ---");
  for (const ip of ["8.8.8.8", "1.1.1.1", "9.9.9.9", "208.67.222.222", "140.82.121.4"]) {
    if (!isPrivateIp(ip)) ok(`allows public ${ip}`);
    else bad(`allows public ${ip}`, "isPrivateIp returned true — over-blocking");
  }
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    if (!isPrivateIp(ip)) ok(`allows public ${ip}`);
    else bad(`allows public ${ip}`, "isPrivateIp returned true — over-blocking");
  }

  console.log("\n--- bracketed and alternate literal forms ---");
  // `new URL(...).hostname` hands back the brackets, and net.isIP() is 0 for
  // them, so the literal branch was skipped entirely.
  for (const h of ["[::ffff:127.0.0.1]", "[::1]", "[::ffff:169.254.169.254]", "[fe80::1]"]) {
    const blocked = await isBlockedTarget(h);
    if (blocked) ok(`blocks bracketed ${h}`);
    else bad(`blocks bracketed ${h}`, "ALLOWED — net.isIP() is 0 for brackets so it fell through");
  }
  // Decimal / hex / octal IPv4, which WHATWG URL normalises to dotted form.
  for (const h of ["2130706433", "0x7f000001", "017700000001", "127.1"]) {
    const blocked = await isBlockedTarget(h);
    if (blocked) ok(`blocks numeric ${h}`);
    else bad(`blocks numeric ${h}`, "ALLOWED");
  }

  console.log("\n--- hostnames ---");
  await Promise.all([
    expectBlocked("blocks localhost", "localhost"),
    expectBlocked("blocks trailing-dot localhost", "localhost."),
    expectBlocked("blocks uppercase LOCALHOST", "LOCALHOST"),
    expectBlocked("blocks *.internal", "db.internal"),
    expectBlocked("blocks *.local", "printer.local"),
    expectBlocked("blocks *.localhost", "x.localhost"),
    expectBlocked("blocks *.invalid", "nope.invalid"),
    expectBlocked("blocks metadata.google.internal", "metadata.google.internal"),
    expectBlocked("blocks trailing-dot metadata host", "metadata.google.internal."),
    expectBlocked("blocks bare 0", "0"),
    expectBlocked("blocks hex-encoded 0x7f.0.0.1 name", "0x7f.0.0.1"),
  ]);

  console.log("\n--- DNS resolution outcomes ---");
  // Fail-closed: a name that cannot resolve must not become a permitted target.
  const unresolvable = await isBlockedTarget("this-host-does-not-exist-9182.invalid");
  if (unresolvable) ok("fails closed on NXDOMAIN");
  else bad("fails closed on NXDOMAIN", "ALLOWED — an unresolvable host was permitted");

  /* ==================================================================== */
  console.log("\n--- tools route: the ping argument-injection boundary ---");
  const toolsSrc = fs.readFileSync(path.join(REPO, "apps/web/app/api/tools/route.ts"), "utf-8");
  // The user-supplied host reached `ping` as a bare argv element, so "-f<ip>"
  // was parsed as a FLAG. The host must be rejected as an operand, not merely
  // screened for being private.
  // A grep for the helper's NAME proves nothing: deleting the CALL leaves the
  // definition in place. Require the guard to be called on every host-accepting
  // branch, and require the flag shape itself to be rejected by the library.
  if (looksLikeFlag("-f127.0.0.1") && looksLikeFlag("--help") && !looksLikeFlag("example.com") && !looksLikeFlag("1.1.1.1")) {
    ok("looksLikeFlag rejects option-shaped operands only");
  } else {
    bad("looksLikeFlag rejects option-shaped operands only", "a flag-shaped or a real host was misclassified");
  }
  const calls = (toolsSrc.match(/rejectProbeOperand\(data\.host\)/g) ?? []).length;
  if (calls >= 2) {
    ok("tools route calls the operand guard on both host-accepting branches");
  } else {
    bad("tools route calls the operand guard on both host-accepting branches",
      `found ${calls} call(s); a host of -f127.0.0.1 becomes a ping flag`);
  }
  const ssrfNow = fs.readFileSync(path.join(REPO, "apps/web/src/lib/ssrf.ts"), "utf-8");
  if (/if \(looksLikeFlag\(host\)\) return true;/.test(ssrfNow)) {
    ok("isBlockedTarget refuses a flag-shaped target itself");
  } else {
    bad("isBlockedTarget refuses a flag-shaped target itself", "the library guard is gone");
  }
  if (/"tcp"[\s\S]{0,900}?isBlockedTarget/.test(toolsSrc)) ok("tcp tool is screened");
  else bad("tcp tool is screened", "guard not adjacent to the tcp branch");
  if (/"latency"[\s\S]{0,900}?isBlockedTarget/.test(toolsSrc)) ok("latency tool is screened");
  else bad("latency tool is screened", "guard not adjacent to the latency branch");
  if (/redirect:\s*"manual"/.test(toolsSrc)) ok("http tool does not follow redirects");
  else bad("http tool does not follow redirects", "redirect: manual absent — a public URL could redirect inward");
  if (/parsed\.username\s*\|\|\s*parsed\.password/.test(toolsSrc)) ok("http tool rejects URL credentials");
  else bad("http tool rejects URL credentials", "no credential check");

  /* ==================================================================== */
  console.log("\n--- XUI exception is scoped and cannot leak ---");
  const xuiSrc = fs.readFileSync(path.join(REPO, "apps/web/app/api/xui/test/route.ts"), "utf-8");
  if (redirectSafe(xuiSrc)) ok("xui route does not follow redirects");
  else bad("xui route does not follow redirects", "redirect: manual absent");
  if (/parsed\.username\s*\|\|\s*parsed\.password/.test(xuiSrc)) ok("xui route rejects URL credentials");
  else bad("xui route rejects URL credentials", "no credential check");
  // The exception is DOCUMENTED and LOCAL. It must not appear in the tools or
  // node routes, and it must not be exported as a shared helper that another
  // route can pick up by accident.
  if (/import[^;]*isBlockedTarget[^;]*from\s*"\@\/lib\/ssrf"/.test(toolsSrc)) ok("tools imports the guard explicitly");
  else bad("tools imports the guard explicitly", "import shape changed — re-verify the exception scope");
  if (!/isBlockedTarget/.test(xuiSrc)) ok("xui route does not call the blocklist (exception is local)");
  else bad("xui route does not call the blocklist", "xui now calls the guard — the exception scope changed");
  // A shared "allow private" export would let any route opt out.
  const ssrfSrc = ssrfNow;
  if (!/export\s+(?:async\s+)?function\s+allowPrivate|export\s+const\s+ALLOW_PRIVATE/.test(ssrfSrc)) {
    ok("ssrf.ts exports no opt-out that another route could adopt");
  } else {
    bad("ssrf.ts exports no opt-out", "an allowPrivate/ALLOW_PRIVATE export exists — exception can spread");
  }
  // The X-UI route still deliberately reaches private/tailnet addresses — a
  // 3X-UI panel usually lives there, and blocking RFC1918 breaks the feature.
  // What must remain true is that the EXCEPTION is stated at the call site, so
  // a future reader knows it is a decision rather than an oversight, and that
  // the route still refuses loopback/link-local via rejectPanelProbeHost.
  // Matched loosely on intent, not on one exact comment wording: an earlier
  // version of this assertion grepped for the literal string
  // "intentionally no SSRF", so rewording the comment (to explain the narrower
  // policy that replaced it) failed the test while the behaviour was correct.
  if (
    /intentionally no SSRF|deliberately reachable|private\/tailnet address space is deliberately/i.test(xuiSrc)
  ) {
    ok("the xui exception is documented in place");
  } else {
    bad("the xui exception is documented in place", "the comment explaining the exception is gone");
  }
  if (/rejectPanelProbeHost\(parsed\.hostname\)/.test(xuiSrc)) {
    ok("the xui route still refuses loopback / link-local via rejectPanelProbeHost");
  } else {
    bad("the xui route still refuses loopback / link-local", "the narrower policy call is missing");
  }

  console.log("\n--- node test route: sanitised errors, no raw stderr ---");
  const nodeTestSrc = fs.readFileSync(path.join(REPO, "apps/web/app/api/nodes/[id]/test/route.ts"), "utf-8");
  if (/: res\.stderr/.test(nodeTestSrc)) {
    bad("node test route does not return raw stderr", "res.stderr is returned verbatim to the browser");
  } else if (/sanitize|sanitise|sshFailureMessage/.test(nodeTestSrc)) {
    ok("node test route returns a sanitised message");
  } else {
    bad("node test route returns a sanitised message", "neither a raw stderr nor a sanitiser found — inspect");
  }

  /* ==================================================================== */
  console.log("\n--- each guard is load-bearing, not just defence in depth ---");
  // The bracket strip and the bare-label check overlap: a bracketed v6 literal
  // has no dot, so the label check would block it even without the strip. Assert
  // the strip on its own, so neither guard can be deleted silently.
  if (unbracketForTest("[::ffff:7f00:1]") === "::ffff:7f00:1") ok("unbracket strips the brackets");
  else bad("unbracket strips the brackets", "got a different value");
  if (unbracketForTest("[::1]") === "::1") ok("unbracket strips a bare loopback literal");
  else bad("unbracket strips a bare loopback literal", "got a different value");
  if (unbracketForTest("1.1.1.1") === "1.1.1.1") ok("unbracket leaves a v4 literal alone");
  else bad("unbracket leaves a v4 literal alone", "got a different value");
  // A bracketed literal must be classified as an ADDRESS, not handed to the
  // resolver as a NAME. isBlockedTarget("[" + private + "]") has to be blocked
  // by the address branch, which is only reachable if the strip ran.
  if (isUnresolvableName("intranet-host") && isUnresolvableName("") && isUnresolvableName("  ")) {
    ok("isUnresolvableName rejects a bare label and an empty target");
  } else {
    bad("isUnresolvableName rejects a bare label and an empty target", "one was accepted");
  }
  // A bracketed literal must be refused as a NAME when a caller hands one over
  // un-stripped. isBlockedTarget strips first, so this is the safety net.
  if (isUnresolvableName("[::ffff:127.0.0.1]") && isUnresolvableName("[::1]")) {
    ok("isUnresolvableName refuses an un-stripped bracketed literal");
  } else {
    bad("isUnresolvableName refuses an un-stripped bracketed literal", "a bracketed literal was treated as a name");
  }
  if (!isUnresolvableName("example.com") && !isUnresolvableName("1.1.1.1")) {
    ok("isUnresolvableName accepts a real FQDN and a literal");
  } else {
    bad("isUnresolvableName accepts a real FQDN and a literal", "over-blocking");
  }
  if (net.isIP("[::ffff:127.0.0.1]") === 0) {
    ok("net.isIP cannot parse a bracketed literal, so the strip is required");
  } else {
    bad("net.isIP cannot parse a bracketed literal", "the premise of this test changed");
  }

  /* ==================================================================== */
  console.log("\n--- describeAddress is safe to log ---");
  const d1 = describeAddress("127.0.0.1");
  const d2 = describeAddress("8.8.8.8");
  if (typeof d1 === "string" && typeof d2 === "string") ok("describeAddress returns a string");
  else bad("describeAddress returns a string", `got ${typeof d1}`);

  /* ==================================================================== */
  console.log("\n--- port-forward destHost is guarded at the API boundary ---");
  // Regression: a port-forward `destHost` becomes a live `net.connect({ host })
  // on the tunnel node (forwarder.ts:63, forwarder-runner.ts:55) or a
  // `gost -L proto://:port/host:port` argv element (engine.ts:1355). Both
  // port-forward routes accepted `z.string().min(1)` with no target check, so
  // an authenticated user could point a node at its own loopback, a private
  // address, or 169.254.169.254 and read the reply through a forward they
  // control. The tools API already blocked this class; the forward API did not.
  const pfCreate = fs.readFileSync(
    path.join(REPO, "apps/web/app/api/port-forwards/route.ts"),
    "utf8",
  );
  const pfUpdate = fs.readFileSync(
    path.join(REPO, "apps/web/app/api/port-forwards/[id]/route.ts"),
    "utf8",
  );

  // The behavioural proof: the guard itself, on the values that matter.
  const forwardBlocked: [string, string][] = [
    ["127.0.0.1", "node loopback"],
    ["169.254.169.254", "cloud metadata"],
    ["10.0.0.5", "RFC1918"],
    ["192.168.1.1", "RFC1918"],
    ["[::1]", "IPv6 loopback"],
    ["[::ffff:127.0.0.1]", "IPv4-mapped IPv6 loopback"],
    ["metadata.google.internal", "metadata by name"],
    ["foo.internal", "internal suffix"],
    ["-f127.0.0.1", "argv injection (not a host)"],
  ];
  for (const [host, why] of forwardBlocked) {
    const problem = await rejectForwardHost(host);
    if (problem) ok(`port-forward refuses ${host} (${why})`);
    else bad(`port-forward refuses ${host} (${why})`, "it was accepted");
  }
  // And the boundary: a routable literal and a real FQDN must still work, or
  // the guard has turned the feature into something unusable.
  for (const host of ["1.1.1.1", "example.com"]) {
    const problem = await rejectForwardHost(host);
    if (!problem) ok(`port-forward still allows a routable target (${host})`);
    else bad(`port-forward still allows a routable target (${host})`, problem);
  }

  // Both write paths must call it — a create-only guard is bypassed by editing
  // an existing rule into an SSRF relay, which is the cheaper attack anyway.
  if (/rejectForwardHost\(body\.data\.destHost\)/.test(pfCreate)) {
    ok("POST /api/port-forwards validates destHost");
  } else {
    bad("POST /api/port-forwards validates destHost", "no guard call found");
  }
  if (/body\.data\.destHost !== undefined[\s\S]{0,200}rejectForwardHost\(body\.data\.destHost\)/.test(pfUpdate)) {
    ok("PUT /api/port-forwards/[id] re-validates a changed destHost");
  } else {
    bad("PUT /api/port-forwards/[id] re-validates a changed destHost", "no guard call found");
  }
  // The guard must run before the row is written, not after.
  const createIdx = pfCreate.indexOf("prisma.portForward.create");
  const guardIdx = pfCreate.indexOf("rejectForwardHost(body.data.destHost)");
  if (guardIdx > 0 && createIdx > guardIdx) {
    ok("the destHost guard runs before the rule is persisted");
  } else {
    bad(
      "the destHost guard runs before the rule is persisted",
      `guard at ${guardIdx}, insert at ${createIdx}`,
    );
  }

  console.log(`\n--- ${passed} passed, ${failed} failed ---`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

function redirectSafe(src: string): boolean {
  return /redirect:\s*"manual"/.test(src);
}

main().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});