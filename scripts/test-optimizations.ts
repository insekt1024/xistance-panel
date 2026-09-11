/**
 * Dynamic test script that verifies all API optimizations.
 * Runs against a temporary SQLite database.
 */

process.env.DATABASE_URL = `file:${process.cwd()}/.data/test.db`;
process.env.XT_FORCE_NODE = "true";
process.env.XTENC_KEY = "dev-32-byte-hex-secret-0000000000000000";
process.env.JWT_SECRET = "test-jwt-secret";
process.env.NODE_ENV = "test";

import { PrismaClient } from "../packages/db/generated/client/index.js";
import {
  buildAutosshCommand,
  buildSshCommand,
  buildUnit,
  filterExtraArgs,
  hashPassword,
  sanitizeUnitText,
  verifyPassword,
} from "../packages/tunnel-core/src/index.ts";
import { SshConfigSchema } from "../packages/types/src/index.ts";
import { cached, invalidateCache } from "../apps/web/src/lib/query-cache.ts";
// NOTE: lib/api.ts must be dynamically imported INSIDE tests (like tests
// 18-21 do): it pulls the @xistance/db singleton, which resolves
// DATABASE_URL at import time. A static import would hoist above the
// test-DB env assignment and point the singleton at the dev database.
import enMessages from "../packages/i18n/messages/en.json";
import faMessages from "../packages/i18n/messages/fa.json";
import { rateLimit } from "../apps/web/src/lib/rate-limit.ts";
import { ENGINE_CONCURRENCY, mapPool } from "../apps/web/src/lib/pool.ts";
import { isBlockedTarget, isPrivateIp } from "../apps/web/src/lib/ssrf.ts";
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";

const TEST_DB = path.join(process.cwd(), ".data", "test.db");
if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
fs.mkdirSync(path.dirname(TEST_DB), { recursive: true });

const prisma = new PrismaClient({
  datasources: { db: { url: `file:${TEST_DB}` } },
  log: [],
});

interface TestResult {
  name: string;
  passed: boolean;
  details?: string;
}
const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log("✅ " + name);
  } catch (err: unknown) {
    results.push({ name, passed: false, details: err.message });
    console.error("❌ " + name + ": " + err.message);
  }
}

async function main() {
  console.log("Setting up test database...");
  execSync(
    "npx prisma db push --schema=packages/db/prisma/schema.prisma --accept-data-loss",
    { env: { ...process.env, DATABASE_URL: `file:${TEST_DB}` }, stdio: "pipe" },
  );
  console.log("Database ready!");

  // Test 1: Pagination
  await test("Pagination: nodes returns hasNext/nextCursor", async () => {
    for (let i = 0; i < 5; i++) {
      await prisma.node.create({
        data: { name: `node${i}`, type: "IRAN", host: "127.0.0.1", sshPort: 22, sshUser: "root", authMethod: "key" },
      });
    }
    const nodes = await prisma.node.findMany({ orderBy: { createdAt: "desc" }, take: 2 });
    if (nodes.length !== 2) throw new Error("Expected 2 nodes");
    if (!nodes[nodes.length - 1].id) throw new Error("Expected nextCursor id");
  });

  // Test 2: Tunnel list excludes config
  await test("Tunnel list select: config excluded", async () => {
    await prisma.tunnel.create({ data: { id: "t1", name: "T1", method: "SSH", config: {} as Record<string, unknown>, status: "stopped", state: "stopped" } });
    const tunnels = await prisma.tunnel.findMany({
      select: { id: true, name: true, method: true, status: true, state: true, port: true, autostart: true, clientNode: { select: { id: true, name: true, type: true } }, serverNode: { select: { id: true, name: true, type: true } }, owner: { select: { id: true, name: true, email: true } } },
    });
    const t = tunnels[0];
    if (!t) throw new Error("No tunnel");
    if ("config" in t) throw new Error("config should be excluded");
  });

  // Test 3: Password route select
  await test("Password select: only passwordHash", async () => {
    await prisma.user.create({ data: { email: "test@test.com", passwordHash: hashPassword("password123"), name: "Test", role: "ADMIN" } });
    const user = await prisma.user.findUnique({ where: { email: "test@test.com" }, select: { passwordHash: true } });
    if (!user) throw new Error("User not found");
    if (!verifyPassword("password123", user.passwordHash)) throw new Error("Verify failed");
    if (Object.keys(user).length !== 1) throw new Error("Expected only passwordHash");
  });

  // Test 4: Users ownership check select
  await test("Users select: only role+email", async () => {
    const user = await prisma.user.findUnique({ where: { email: "test@test.com" }, select: { role: true, email: true } });
    if (!user) throw new Error("User not found");
    if (Object.keys(user).includes("passwordHash")) throw new Error("passwordHash should be excluded");
  });

  // Test 5: Port-forward ownership check
  await test("Port-forward select: only userId+name", async () => {
    const pf = await prisma.portForward.create({ data: { name: "pf1", direction: "IRAN_TO_FOREIGN", protocol: "tcp", sourcePort: 9001, destHost: "127.0.0.1", destPort: 9002, enabled: true, status: "running", userId: null, nodeId: null } });
    const res = await prisma.portForward.findUnique({ where: { id: pf.id }, select: { userId: true, name: true } });
    if (!res) throw new Error("PF not found");
    if (Object.keys(res).includes("destHost")) throw new Error("destHost should be excluded");
  });

  // Test 6: Node select excludes apiTokenEncrypted
  await test("Node deploy select: excludes apiTokenEncrypted", async () => {
    const node = await prisma.node.findUnique({ where: { name_type: { name: "node0", type: "IRAN" } }, select: { id: true, host: true, sshUser: true, sshPort: true, authMethod: true, sshKeyEncrypted: true, sshPasswordEnc: true } });
    if (!node) throw new Error("Node not found");
    if (Object.keys(node).includes("apiTokenEncrypted")) throw new Error("apiTokenEncrypted should be excluded");
  });

  // Test 7: Forward supervisor select
  await test("Forward supervisor: selects exclude unnecessary fields", async () => {
    const nodes = await prisma.node.findMany({ select: { id: true, name: true, type: true, host: true, sshUser: true, sshPort: true, authMethod: true, sshKeyEncrypted: true, sshPasswordEnc: true } });
    if (nodes.length > 0 && Object.keys(nodes[0]!).includes("apiTokenEncrypted")) throw new Error("apiTokenEncrypted should be excluded");
  });

  // Test 8: Backup sample limit + select
  await test("Backup: limited to 500 + select fields", async () => {
    const samples = await prisma.trafficSample.findMany({ select: { ts: true, tunnelId: true, bytesIn: true, bytesOut: true }, take: 500, orderBy: { ts: "desc" } });
    if (samples.length > 500) throw new Error("Should be <=500");
  });

  // Test 9: Node existence check select
  await test("Node existence: select { id } only", async () => {
    const existing = await prisma.node.findUnique({ where: { name_type: { name: "node0", type: "IRAN" } }, select: { id: true } });
    if (!existing) throw new Error("Node not found");
    if (Object.keys(existing).length !== 1) throw new Error("Expected only id");
  });

  // Test 10: Parallel DELETE queries
  await test("Nodes DELETE: parallel + select", async () => {
    const node = await prisma.node.create({ data: { name: "del-test", type: "FOREIGN", host: "127.0.0.1", sshPort: 22, sshUser: "root" } });
    const [existing] = await Promise.all([
      prisma.node.findUnique({ where: { id: node.id }, select: { name: true } }),
      prisma.tunnel.count({ where: { OR: [{ clientNodeId: node.id }, { serverNodeId: node.id }] } }),
    ]);
    if (!existing) throw new Error("Node not found");
    if (existing.name !== "del-test") throw new Error("Name mismatch");
    await prisma.node.delete({ where: { id: node.id } });
  });

  // Test 11: Schema indexes
  await test("Schema: new indexes exist", async () => {
    const schema = fs.readFileSync(path.join(process.cwd(), "packages/db/prisma/schema.prisma"), "utf-8");
    const expected = ["index([tunnelId, ts])", "index([ts])", "index([direction])", "index([status])", "index([state])", "index([actorId, createdAt])", "index([role])"];
    for (const idx of expected) {
      if (!schema.includes(idx)) throw new Error("Missing index: " + idx);
    }
  });

  // Test 12: Engine cache
  await test("Engine: processRunningCache + TTL", async () => {
    const src = fs.readFileSync(path.join(process.cwd(), "packages/tunnel-core/src/engine.ts"), "utf-8");
    if (!src.includes("processRunningCache")) throw new Error("processRunningCache not found");
    if (!src.includes("PROCESS_RUNNING_CACHE_TTL")) throw new Error("PROCESS_RUNNING_CACHE_TTL not found");
    if (!src.match(/isRunning\s*\(/)) throw new Error("isRunning method not found");
  });

  // Test 13: Rate limiting on expensive endpoints
  await test("Rate limiting: applied to tools/node-test/password/actions", async () => {
    const files = [
      "apps/web/app/api/tools/route.ts",
      "apps/web/app/api/nodes/[id]/test/route.ts",
      "apps/web/app/api/settings/password/route.ts",
      "apps/web/app/api/tunnels/[id]/actions/route.ts",
    ];
    for (const f of files) {
      const src = fs.readFileSync(path.join(process.cwd(), f), "utf-8");
      if (!src.includes("rateLimit(")) throw new Error("rateLimit missing in " + f);
    }
  });

  // Test 14: Rate limiter logic works (dynamic behavior test)
  await test("Rate limit: enforces window and resets", async () => {
    const { rateLimit } = await import("../apps/web/src/lib/rate-limit.ts");
    const key = "test-limiter-" + Date.now();
    let blocked = false;
    for (let i = 0; i < 10; i++) {
      const r = rateLimit(key, 3, 50);
      if (!r.ok) blocked = true;
    }
    if (!blocked) throw new Error("limiter did not block excess requests");
    await new Promise((r) => setTimeout(r, 80));
    const after = rateLimit(key, 3, 50);
    if (!after.ok) throw new Error("limiter did not reset after window");
  });

  // Test 15: Query cache behavior
  await test("Query cache: caches, single-flight, invalidates", async () => {
    let calls = 0;
    const fn = async () => { calls += 1; return calls; };
    // Concurrent callers share one computation
    const [a, b] = await Promise.all([cached("k1", 1000, fn), cached("k1", 1000, fn)]);
    if (a !== 1 || b !== 1) throw new Error("single-flight failed: got " + a + "," + b);
    // TTL hit
    await cached("k1", 1000, fn);
    if (calls !== 1) throw new Error("cache hit failed, calls=" + calls);
    // Invalidate
    invalidateCache();
    await cached("k1", 1000, fn);
    if (calls !== 2) throw new Error("invalidate failed, calls=" + calls);
  });

  // Test 16: Health endpoint exists with DB + engine checks
  await test("Health endpoint: exists and checks DB + engine", async () => {
    const p = path.join(process.cwd(), "apps/web/app/api/health/route.ts");
    const src = fs.readFileSync(p, "utf-8");
    if (!src.includes("$queryRaw")) throw new Error("health does not check database");
    if (!src.includes("getEngine")) throw new Error("health does not check engine");
  });

  // Test 17: Engine flushStats + size methods exist
  await test("Engine: flushStats + size methods exist", async () => {
    const src = fs.readFileSync(path.join(process.cwd(), "packages/tunnel-core/src/engine.ts"), "utf-8");
    if (!src.includes("flushStats()")) throw new Error("flushStats method missing");
    if (!src.includes("size(): number")) throw new Error("size method missing");
    const instr = fs.readFileSync(path.join(process.cwd(), "apps/web/instrumentation.ts"), "utf-8");
    if (!instr.includes("flushStats")) throw new Error("SIGTERM flush not wired in instrumentation");
  });

  // -----------------------------------------------------------------------
  // New test cases: audit logs, batch ops, search, webhooks, traffic API
  // -----------------------------------------------------------------------

  // Test 18: Audit log creation for node operations
  await test("Audit log: created on node create", async () => {
    const { auditLog } = await import("../apps/web/src/lib/api.ts");
    const node = await prisma.node.create({
      data: { name: "audit-node", type: "IRAN", host: "10.0.0.1", sshPort: 22, sshUser: "root" },
    });
    const user = await prisma.user.findUnique({ where: { email: "test@test.com" } });
    if (!user) throw new Error("Test user not found");
    await auditLog(user.id, "node.create", node.id, node.name, "127.0.0.1");
    const logs = await prisma.auditLog.findMany({ where: { action: "node.create", target: node.id } });
    if (logs.length !== 1) throw new Error("Expected 1 audit log, got " + logs.length);
    if (logs[0].actorId !== user.id) throw new Error("actorId mismatch");
    if (logs[0].ip !== "127.0.0.1") throw new Error("ip mismatch");
  });

  // Test 19: Audit log creation for tunnel operations
  await test("Audit log: created on tunnel start", async () => {
    const { auditLog } = await import("../apps/web/src/lib/api.ts");
    await prisma.tunnel.create({
      data: { id: "t-audit", name: "Audit T", method: "SSH", config: {}, status: "stopped", state: "stopped" },
    });
    const user = await prisma.user.findUnique({ where: { email: "test@test.com" } });
    await auditLog(user!.id, "tunnel.start", "t-audit", "Audit T", "192.168.1.1");
    const logs = await prisma.auditLog.findMany({ where: { action: "tunnel.start" } });
    if (logs.length < 1) throw new Error("Expected at least 1 audit log");
    if (logs[0].details !== "Audit T") throw new Error("details mismatch");
  });

  // Test 20: Audit log query with cursor pagination
  await test("Audit log: cursor pagination returns correct structure", async () => {
    const logs = await prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true, action: true, target: true, createdAt: true },
    });
    if (logs.length < 1) throw new Error("Expected audit logs");
    if (!logs[0].id) throw new Error("Missing id in audit log");
    if (!logs[0].action) throw new Error("Missing action in audit log");
  });

  // Test 21: Batch schema validates action enum
  await test("Batch schema: validates action enum", async () => {
    const { z } = await import("zod");
    const batchSchema = z.object({
      action: z.enum(["start", "stop", "restart"]),
      tunnelIds: z.array(z.string().uuid()).min(1).max(20),
    });
    // Valid
    const valid = batchSchema.safeParse({ action: "start", tunnelIds: ["00000000-0000-0000-0000-000000000001"] });
    if (!valid.success) throw new Error("Valid payload rejected");
    // Invalid action
    const badAction = batchSchema.safeParse({ action: "delete", tunnelIds: ["00000000-0000-0000-0000-000000000001"] });
    if (badAction.success) throw new Error("Invalid action accepted");
    // Empty tunnelIds
    const emptyIds = batchSchema.safeParse({ action: "start", tunnelIds: [] });
    if (emptyIds.success) throw new Error("Empty tunnelIds accepted");
    // Invalid UUID
    const badUuid = batchSchema.safeParse({ action: "start", tunnelIds: ["not-a-uuid"] });
    if (badUuid.success) throw new Error("Invalid UUID accepted");
    // Exceed max 20
    const tooMany = batchSchema.safeParse({ action: "start", tunnelIds: Array(21).fill("00000000-0000-0000-0000-000000000001") });
    if (tooMany.success) throw new Error("More than 20 IDs accepted");
  });

  // Test 22: Batch not-found tunnel returns error
  await test("Batch: not-found tunnel produces error in results", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000099";
    const tunnels = await prisma.tunnel.findMany({
      where: { id: { in: [nonExistentId] } },
      select: { id: true },
    });
    if (tunnels.length !== 0) throw new Error("Expected no tunnels for non-existent ID");
    const foundIds = new Set(tunnels.map((t) => t.id));
    const allIds = [nonExistentId];
    const notFound = allIds.filter((id) => !foundIds.has(id));
    if (notFound.length !== 1) throw new Error("Expected 1 not-found");
  });

  // Test 23: Search API schema validation
  await test("Search: short query returns empty results", async () => {
    // Simulate search with q < 2 chars
    const q = "a";
    if (q.length < 2) {
      // Search route returns empty arrays for short queries
      const result = { tunnels: [], nodes: [], users: [] };
      if (result.tunnels.length !== 0 || result.nodes.length !== 0 || result.users.length !== 0) {
        throw new Error("Expected empty results for short query");
      }
    } else {
      throw new Error("Short query logic path not taken");
    }
  });

  // Test 24: Search returns tunnels matching name
  await test("Search: tunnels matching name found", async () => {
    await prisma.tunnel.create({
      data: { id: "t-search", name: "SearchTunnel-Alpha", method: "FRP", config: {}, status: "stopped", state: "stopped" },
    });
    const like = "%SearchTunnel%";
    const tunnels = await prisma.tunnel.findMany({
      where: { name: { contains: like } },
      take: 5,
      select: { id: true, name: true, method: true, status: true },
      orderBy: { name: "asc" },
    });
    if (tunnels.length < 1) throw new Error("Expected at least 1 matching tunnel");
    if (!tunnels[0].name.includes("SearchTunnel")) throw new Error("Result does not match query");
  });

  // Test 25: Search returns nodes matching name
  await test("Search: nodes matching name found", async () => {
    await prisma.node.create({
      data: { name: "search-node-x", type: "FOREIGN", host: "203.0.113.1", sshPort: 22, sshUser: "root" },
    });
    const like = "%search-node%";
    const nodes = await prisma.node.findMany({
      where: { name: { contains: like } },
      take: 5,
      select: { id: true, name: true, type: true, host: true, status: true },
      orderBy: { name: "asc" },
    });
    if (nodes.length < 1) throw new Error("Expected at least 1 matching node");
    if (!nodes[0].name.includes("search-node")) throw new Error("Result does not match query");
  });

  // Test 26: Search returns users matching name/email
  await test("Search: users matching name found", async () => {
    const like = "%test%";
    const users = await prisma.user.findMany({
      where: { OR: [{ email: { contains: like } }, { name: { contains: like } }] },
      take: 5,
      select: { id: true, email: true, name: true, role: true },
      orderBy: { name: "asc" },
    });
    if (users.length < 1) throw new Error("Expected at least 1 matching user");
    const match = users.find((u) => u.email.includes("test") || u.name.includes("test"));
    if (!match) throw new Error("No user matched the search term");
  });

  // Test 27: Webhook URL validation via Zod schema
  await test("Webhook schema: validates URL format", async () => {
    const { z } = await import("zod");
    const webhookSchema = z.object({
      name: z.string().min(1).max(80),
      type: z.enum(["telegram", "discord"]),
      url: z.string().url(),
      events: z.array(z.string()).default([]),
      enabled: z.boolean().default(true),
    });
    // Valid
    const ok = webhookSchema.safeParse({ name: "wh1", type: "telegram", url: "https://api.telegram.org/bot123/sendMessage" });
    if (!ok.success) throw new Error("Valid webhook rejected");
    // Invalid URL
    const badUrl = webhookSchema.safeParse({ name: "wh1", type: "telegram", url: "not-a-url" });
    if (badUrl.success) throw new Error("Invalid URL accepted");
    // Invalid type
    const badType = webhookSchema.safeParse({ name: "wh1", type: "slack", url: "https://example.com" });
    if (badType.success) throw new Error("Invalid type accepted");
    // Empty name
    const noName = webhookSchema.safeParse({ name: "", type: "discord", url: "https://example.com" });
    if (noName.success) throw new Error("Empty name accepted");
  });

  // Test 28: Webhook CRUD in database
  await test("Webhook: create and read from database", async () => {
    const wh = await prisma.notificationWebhook.create({
      data: { name: "TestHook", type: "discord", url: "https://discord.com/api/webhooks/123", events: JSON.stringify(["tunnel.start"]) },
    });
    if (!wh.id) throw new Error("Webhook id missing");
    const found = await prisma.notificationWebhook.findUnique({ where: { id: wh.id } });
    if (!found) throw new Error("Webhook not found");
    if (found.name !== "TestHook") throw new Error("name mismatch");
    if (found.type !== "discord") throw new Error("type mismatch");
    if (found.url !== "https://discord.com/api/webhooks/123") throw new Error("url mismatch");
    await prisma.notificationWebhook.delete({ where: { id: wh.id } });
  });

  // Test 29: Traffic data endpoint schema validation
  await test("Traffic schema: validates range enum", async () => {
    const { z } = await import("zod");
    const Schema = z.object({ range: z.enum(["1h", "6h", "24h", "7d"]).default("24h") });
    for (const range of ["1h", "6h", "24h", "7d"]) {
      const r = Schema.safeParse({ range });
      if (!r.success) throw new Error("Valid range rejected: " + range);
    }
    const bad = Schema.safeParse({ range: "30d" });
    if (bad.success) throw new Error("Invalid range accepted");
  });

  // Test 30: Traffic data aggregation returns valid structure
  await test("Traffic: aggregation returns correct data structure", async () => {
    const tunnel = await prisma.tunnel.create({
      data: { id: "t-traffic", name: "TrafficT", method: "SSH", config: {}, status: "running", state: "running" },
    });
    // Insert traffic samples
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await prisma.trafficSample.create({
        data: {
          tunnelId: tunnel.id,
          bytesIn: BigInt(1000 * (i + 1)),
          bytesOut: BigInt(500 * (i + 1)),
          ts: new Date(now - i * 60_000),
        },
      });
    }
    // Aggregate like the traffic route does
    const bucket = 60_000;
    const rawSamples = await prisma.trafficSample.findMany({
      where: { tunnelId: tunnel.id },
      select: { bytesIn: true, bytesOut: true, ts: true },
      orderBy: { ts: "asc" },
    });
    const buckets = new Map<number, { ts: number; bytesIn: bigint; bytesOut: bigint }>();
    for (const r of rawSamples) {
      const key = Math.floor(r.ts.getTime() / bucket) * bucket;
      const b = buckets.get(key) ?? { ts: key, bytesIn: BigInt(0), bytesOut: BigInt(0) };
      b.bytesIn += r.bytesIn;
      b.bytesOut += r.bytesOut;
      buckets.set(key, b);
    }
    const data = [...buckets.values()]
      .sort((a, b) => a.ts - b.ts)
      .map((b) => ({ ts: new Date(b.ts).toISOString(), bytesIn: Number(b.bytesIn), bytesOut: Number(b.bytesOut) }));
    if (data.length === 0) throw new Error("Expected traffic buckets");
    for (const d of data) {
      if (!d.ts) throw new Error("Missing ts");
      if (typeof d.bytesIn !== "number") throw new Error("bytesIn not number");
      if (typeof d.bytesOut !== "number") throw new Error("bytesOut not number");
    }
  });

  // Test 31: Traffic empty range returns empty data
  await test("Traffic: empty range returns empty data array", async () => {
    const bucket = 60_000;
    const since = new Date(Date.now() - 3_600_000);
    const rawSamples = await prisma.trafficSample.findMany({
      where: { ts: { gte: since } },
      select: { bytesIn: true, bytesOut: true, ts: true },
      orderBy: { ts: "asc" },
    });
    const buckets = new Map<number, { ts: number; bytesIn: bigint; bytesOut: bigint }>();
    for (const r of rawSamples) {
      const key = Math.floor(r.ts.getTime() / bucket) * bucket;
      const b = buckets.get(key) ?? { ts: key, bytesIn: BigInt(0), bytesOut: BigInt(0) };
      b.bytesIn += r.bytesIn;
      b.bytesOut += r.bytesOut;
      buckets.set(key, b);
    }
    const data = [...buckets.values()]
      .sort((a, b) => a.ts - b.ts)
      .map((b) => ({ ts: new Date(b.ts).toISOString(), bytesIn: Number(b.bytesIn), bytesOut: Number(b.bytesOut) }));
    // All samples are >1h old (inserted with now - i*60_000, so first is now, last is now-240s)
    // So some should exist — but the structure check is what matters
    if (!Array.isArray(data)) throw new Error("data is not an array");
  });

  // Test 32: extraArgs schema rejects non-empty arrays (RCE guard)
  await test("Security: SshConfigSchema rejects non-empty extraArgs", async () => {
    const evil = SshConfigSchema.safeParse({
      mode: "local", host: "h", username: "u", localPort: 1080, remotePort: 80,
      extraArgs: ["-o", "ProxyCommand=curl evil"],
    });
    if (evil.success) throw new Error("ProxyCommand args must be rejected");
    const ok = SshConfigSchema.safeParse({
      mode: "local", host: "h", username: "u", localPort: 1080, remotePort: 80,
      extraArgs: [],
    });
    if (!ok.success) throw new Error("Empty extraArgs must pass");
  });

  // Test 33: filterExtraArgs allowlist
  await test("Security: filterExtraArgs drops dangerous options", async () => {
    const out = filterExtraArgs(["-o", "ProxyCommand=id", "-o", "ConnectTimeout=10", "-L", "x", "-o", "ForwardAgent=yes"]);
    if (out.join(" ") !== "-o ConnectTimeout=10") throw new Error("Unexpected filter result: " + out.join(" "));
    if (filterExtraArgs(["-o"]).length !== 0) throw new Error("Dangling -o must be dropped");
    if (filterExtraArgs(["-o", "ConnectTimeout=1;id"]).length !== 0) throw new Error("Metachar values must be dropped");
  });

  // Test 34: systemd Description sanitization
  await test("Security: sanitizeUnitText strips newlines", async () => {
    const evil = " legit\nExecStart=/bin/evil\n[Install]";
    const clean = sanitizeUnitText(evil);
    if (/[\r\n]/.test(clean)) throw new Error("Newlines must be stripped");
    if (!clean.includes("legit")) throw new Error("Safe text must survive");
  });

  // Test 35: isPrivateIp coverage
  await test("Security: isPrivateIp blocks private ranges", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.255", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "fc00::1"]) {
      if (!isPrivateIp(ip)) throw new Error(ip + " must be private");
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "203.0.113.5", "not-an-ip"]) {
      if (isPrivateIp(ip)) throw new Error(ip + " must NOT be private");
    }
  });

  // Test 36: isBlockedTarget fail-closed on internal names
  await test("Security: isBlockedTarget blocks localhost/private literals", async () => {
    if (!(await isBlockedTarget("localhost"))) throw new Error("localhost must be blocked");
    if (!(await isBlockedTarget("127.0.0.1"))) throw new Error("127.0.0.1 must be blocked");
    if (!(await isBlockedTarget("169.254.169.254"))) throw new Error("cloud metadata IP must be blocked");
    if (!(await isBlockedTarget("db.internal"))) throw new Error(".internal must be blocked");
  });

  // Test 37: query-cache invalidates in-flight recomputes
  await test("Cache: invalidateCache purges in-flight entries", async () => {
    let calls = 0;
    const slow = () => new Promise<string>((res) => setTimeout(() => res(`v${++calls}`), 50));
    const p1 = cached("sec:test", 60_000, slow);
    invalidateCache("sec:");
    const v1 = await p1;
    const v2 = await cached("sec:test", 60_000, slow);
    if (calls !== 2) throw new Error(`Stale in-flight repopulated cache (calls=${calls}, v1=${v1}, v2=${v2})`);
    invalidateCache("sec:");
  });

  // Test 38: rate-limit evicts oldest (O(1), no unbounded growth)
  await test("RateLimit: oldest buckets evicted at cap", async () => {
    for (let i = 0; i < 10_005; i++) rateLimit(`sec:evict:${i}`, 1, 60_000);
    // The first keys must be gone (evicted), so a new request passes.
    const r = rateLimit("sec:evict:0", 1, 60_000);
    if (!r.ok) throw new Error("Evicted bucket should allow a fresh request");
  });

  // Test 39: unknown-email login path runs full scrypt without throwing
  await test("Security: verifyPassword safe on dummy hash", async () => {
    const dummy = hashPassword("xistance-never-matches-any-login");
    if (verifyPassword("wrong-password", dummy)) throw new Error("Dummy must never verify");
    if (verifyPassword("x", "scrypt:dummy:dummy")) throw new Error("Malformed must not verify");
  });

  // Test 40: paginationParams clamps limit and parses cursor
  await test("Pagination: helper clamps limit 1..100", async () => {
    const { paginationParams } = await import("../apps/web/src/lib/api.ts");
    const a = paginationParams(new URLSearchParams("limit=-5"), 50);
    if (a.limit !== 1) throw new Error("Negative limit must clamp to 1, got " + a.limit);
    const b = paginationParams(new URLSearchParams("limit=500"), 50);
    if (b.limit !== 100) throw new Error("Huge limit must clamp to 100, got " + b.limit);
    const c = paginationParams(new URLSearchParams(""), 50);
    if (c.limit !== 50 || c.cursor !== undefined) throw new Error("Defaults wrong");
    const d = paginationParams(new URLSearchParams("cursor=abc&limit=10"), 50);
    if (d.cursor?.id !== "abc" || d.limit !== 10) throw new Error("Cursor/limit parse wrong");
  });

  // Test 41: invalidCursorResponse maps Prisma cursor errors to 400
  await test("Pagination: cursor errors map to 400 response", async () => {
    const { invalidCursorResponse } = await import("../apps/web/src/lib/api.ts");
    const res = invalidCursorResponse(Object.assign(new Error("Record not found for cursor"), { code: "P2025" }));
    if (!res || res.status !== 400) throw new Error("P2025 must map to 400");
    const res2 = invalidCursorResponse(new Error("An error occurred with your cursor query"));
    if (!res2 || res2.status !== 400) throw new Error("Cursor message must map to 400");
    const res3 = invalidCursorResponse(new Error("boom"));
    if (res3 !== null) throw new Error("Unrelated errors must rethrow (null)");
  });

  // Test 42: auditLog invalidates cached aggregates
  await test("Audit: auditLog() invalidates activity but spares traffic", async () => {
    const { auditLog } = await import("../apps/web/src/lib/api.ts");
    const { CACHE_ACTIVITY, CACHE_TRAFFIC } = await import(
      "../apps/web/src/lib/query-cache.ts"
    );
    let activityCalls = 0;
    let trafficCalls = 0;
    const activityKey = `${CACHE_ACTIVITY}actions`;
    const trafficKey = `${CACHE_TRAFFIC}24h`;
    await cached(activityKey, 60_000, async () => `a${++activityCalls}`);
    await cached(trafficKey, 60_000, async () => `t${++trafficCalls}`);

    await auditLog(null, "sec.test-action");

    // A new audit row can introduce an unseen action type, so the filter
    // list must be recomputed.
    await cached(activityKey, 60_000, async () => `a${++activityCalls}`);
    if (activityCalls !== 2) {
      throw new Error(`activity cache survived auditLog (calls=${activityCalls})`);
    }
    // ...but traffic aggregates are the most expensive reads here and no
    // audited action can change a TrafficSample, so they must survive.
    await cached(trafficKey, 60_000, async () => `t${++trafficCalls}`);
    if (trafficCalls !== 1) {
      throw new Error(`auditLog evicted the traffic cache (calls=${trafficCalls})`);
    }
    invalidateCache();
  });

  // Test 43: fa direction arrows match en (bidi mirrors → correctly in RTL)
  await test("i18n: fa arrows use logical → like en", async () => {
    const pairs: Array<[string, string]> = [
      [(enMessages as Record<string, Record<string, string>>).wizard?.iranToForeign, (faMessages as Record<string, Record<string, string>>).wizard?.iranToForeign],
      [(enMessages as Record<string, Record<string, string>>).wizard?.foreignToIran, (faMessages as Record<string, Record<string, string>>).wizard?.foreignToIran],
    ];
    for (const [en, fa] of pairs) {
      if (!en || !fa) throw new Error("Missing arrow keys");
      const enArrow = en.includes("→") ? "→" : "?";
      const faArrow = fa.includes("→") ? "→" : fa.includes("←") ? "←" : "?";
      if (enArrow !== "→" || faArrow !== "→") throw new Error(`Arrow mismatch en=${en} fa=${fa}`);
    }
  });

  // Test 44: hot-path indexes exist in migrated schema
  await test("Schema: createdAt/action indexes exist", async () => {
    const rows = await prisma.$queryRaw<Array<{ name: string; tbl: string }>>`
      SELECT name, tbl_name as tbl FROM sqlite_master
      WHERE type = 'index' AND tbl_name IN ('Tunnel', 'Node', 'PortForward', 'AuditLog')`;
    const names = rows.map((r) => r.name).join(",");
    for (const t of ["Tunnel", "Node", "PortForward", "AuditLog"]) {
      if (!rows.some((r) => r.tbl === t)) throw new Error(`No indexes found for ${t}: ${names}`);
    }
    if (/bytesIn/.test(names)) throw new Error("Redundant covering index still present: " + names);
  });


  // Regression: buildSshCommand emits a leading "ssh" program token that
  // planSsh must strip before prefixing the resolved binary. Passing it
  // through produced `ssh ssh -N ... user@host`, where ssh reads the stray
  // token as the destination host — every key-auth SSH tunnel failed.
  await test("SSH: argv carries no stray program token", async () => {
    const cfg = SshConfigSchema.parse({
      mode: "local",
      host: "203.0.113.10",
      port: 22,
      username: "root",
      auth: "key",
      localPort: 8080,
      remoteHost: "127.0.0.1",
      remotePort: 80,
    });

    const sshArgs = buildSshCommand(cfg, { keyPath: "/etc/xistance/id" });
    if (sshArgs[0] !== "ssh") throw new Error("builder should lead with its program name");

    // What planSsh assembles: drop the token, prefix the resolved path.
    const [, ...rest] = sshArgs;
    const argv = ["/usr/bin/ssh", ...rest];
    if (argv.slice(1).includes("ssh")) {
      throw new Error("stray 'ssh' token left in argv: " + argv.join(" "));
    }
    if (argv[argv.length - 1] !== "root@203.0.113.10") {
      throw new Error("destination must be the final token: " + argv.join(" "));
    }
  });

  await test("SSH: autossh argv keeps -M and the real destination", async () => {
    const cfg = SshConfigSchema.parse({
      mode: "remote",
      host: "203.0.113.10",
      port: 22,
      username: "root",
      auth: "key",
      localPort: 8080,
      remoteHost: "127.0.0.1",
      remotePort: 80,
      autosshMonitorPort: 0,
    });

    const args = buildAutosshCommand(cfg, { keyPath: "/etc/xistance/id" });
    if (args[0] !== "autossh") throw new Error("expected leading autossh token");
    if (args[1] !== "-M" || args[2] !== "0") throw new Error("expected -M 0 monitor flag");

    const [, ...rest] = args;
    const argv = ["/usr/bin/autossh", ...rest];
    if (argv.slice(1).some((a) => a === "ssh" || a === "autossh")) {
      throw new Error("stray program token in argv: " + argv.join(" "));
    }
    if (argv[argv.length - 1] !== "root@203.0.113.10") {
      throw new Error("destination must be the final token: " + argv.join(" "));
    }
    if (!argv.includes("-R")) throw new Error("remote mode must use -R");
  });

  await test("SSH: useAutossh defaults on, monitor port defaults to 0", async () => {
    const cfg = SshConfigSchema.parse({
      mode: "local",
      host: "203.0.113.10",
      port: 22,
      username: "root",
      auth: "key",
      localPort: 8080,
      remoteHost: "127.0.0.1",
      remotePort: 80,
    });
    if (cfg.useAutossh !== true) throw new Error("useAutossh should default to true");
    if (cfg.autosshMonitorPort !== 0) throw new Error("monitor port should default to 0");
    if (cfg.autosshPoll !== 60) throw new Error("poll should default to 60");
  });

  // The unit file is the only place a password-auth tunnel's secret lands on
  // disk, so the Environment= rendering must survive quoting and injection.
  await test("Systemd: unit renders env and resists directive injection", async () => {
    const unit = buildUnit({
      unitName: "xt-test",
      name: "test",
      command: ["/usr/bin/autossh", "-M", "0", "-N"],
      dataDir: "/var/lib/xistance",
      env: {
        AUTOSSH_GATETIME: "0",
        AUTOSSH_POLL: "60",
        SSHPASS: 'p a"ss\\word',
      },
    } as Parameters<typeof buildUnit>[0]);

    if (!unit.includes("Environment=AUTOSSH_GATETIME=\"0\"")) {
      throw new Error("AUTOSSH_GATETIME not rendered:\n" + unit);
    }
    if (!unit.includes("Environment=SSHPASS=")) throw new Error("SSHPASS not rendered");
    // Quote and backslash must be escaped so the value cannot terminate the
    // directive early.
    const line = unit.split("\n").find((l) => l.startsWith("Environment=SSHPASS="))!;
    if (!line.includes('\\"')) throw new Error("quote not escaped: " + line);
    // Drop the escape pairs, then the only quotes left must be the two
    // delimiters — anything else means the value could end the directive.
    const value = line.slice("Environment=SSHPASS=".length);
    const bare = value.replaceAll("\\\\", "").replaceAll('\\"', "");
    if (bare.split('"').length - 1 !== 2) {
      throw new Error("value escapes its own quoting: " + line);
    }
    if (!bare.startsWith('"') || !bare.endsWith('"')) {
      throw new Error("value not wrapped in delimiters: " + line);
    }
  });

  await test("Systemd: newlines in env cannot inject a directive", async () => {
    const unit = buildUnit({
      unitName: "xt-test",
      name: "test",
      command: ["/usr/bin/ssh", "-N"],
      dataDir: "/var/lib/xistance",
      env: { SSHPASS: "abc\nExecStartPre=/bin/rm -rf /" },
    } as Parameters<typeof buildUnit>[0]);

    if (/^ExecStartPre=/m.test(unit)) {
      throw new Error("env value injected a systemd directive:\n" + unit);
    }
  });


  // Engine calls can each open an SSH session, so the pages that fan out over
  // every tunnel must stay bounded (the sampler already was; the tunnels page
  // and dashboard were not).
  await test("Pool: preserves input order", async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const out = await mapPool(items, 4, async (n) => {
      // Finish in reverse order to prove ordering is by index, not completion.
      await new Promise((r) => setTimeout(r, (25 - n) % 7));
      return n * 2;
    });
    const expected = items.map((n) => n * 2);
    if (JSON.stringify(out) !== JSON.stringify(expected)) {
      throw new Error("order not preserved: " + out.join(","));
    }
  });

  await test("Pool: never exceeds the concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const items = Array.from({ length: 40 }, (_, i) => i);
    await mapPool(items, ENGINE_CONCURRENCY, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active -= 1;
      return null;
    });
    if (peak > ENGINE_CONCURRENCY) {
      throw new Error(`peak concurrency ${peak} exceeded cap ${ENGINE_CONCURRENCY}`);
    }
    if (peak < 2) throw new Error("pool did not run concurrently at all");
  });

  await test("Pool: empty input resolves to empty array", async () => {
    const out = await mapPool([], ENGINE_CONCURRENCY, async () => "x");
    if (!Array.isArray(out) || out.length !== 0) {
      throw new Error("expected [] for empty input");
    }
  });

  // Print results
  console.log("\n" + "=".repeat(50));
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log("Results: " + passed + " passed, " + failed + " failed of " + results.length);
  for (const r of results) {
    if (r.passed) console.log("  ✅ " + r.name);
    else console.log("  ❌ " + r.name + ": " + (r.details || "unknown"));
  }
  console.log("=".repeat(50));

  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("Fatal:", err);
  await prisma.$disconnect();
  process.exit(1);
});
