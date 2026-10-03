import { z } from "zod";
import { prisma } from "@xistance/db";
import { apiError, auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";
import { reconcilePortForwardsSoon } from "@/lib/forward-supervisor";
import { rateLimit } from "@/lib/rate-limit";
import { rejectForwardHost } from "@/lib/forward-host";
import {
  AUTO_PORT_END,
  AUTO_PORT_START,
  PortRangeExhaustedError,
  allocatePortAsync,
  findFreePort,
  isPortOccupied,
  usedPortsOf,
} from "@/lib/ports";

const ruleSchema = z.object({
  name: z.string().min(1).max(80),
  direction: z.enum(["IRAN_TO_FOREIGN", "FOREIGN_TO_IRAN"]),
  protocol: z.enum(["tcp", "udp"]),
  // 0 (or omitted) = automatic: the server allocates the first free port.
  // Simple mode sends 0; advanced mode sends an explicit port.
  sourcePort: z.number().int().min(0).max(65535).default(0),
  destHost: z.string().min(1),
  destPort: z.number().int().min(1).max(65535),
  enabled: z.boolean().default(true),
  nodeId: z.string().uuid().optional().nullable(),
  auto: z.boolean().default(false),
});

/** Ports occupied by active tunnels + all forward rules (any protocol — a
 *  TCP and UDP listener can share a number, but auto-allocate avoids the
 *  number entirely so simple-mode rules never collide with anything). */
async function collectUsedPorts(): Promise<Set<number>> {
  const [tunnels, rules] = await Promise.all([
    prisma.tunnel.findMany({
      where: { status: { in: ["running", "starting"] } },
      select: { port: true },
    }),
    prisma.portForward.findMany({ select: { sourcePort: true } }),
  ]);
  return usedPortsOf(
    tunnels.map((t) => t.port),
    rules.map((r) => r.sourcePort),
  );
}

const LIST_LIMIT = 50;

export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const { searchParams } = new URL(request.url);
  // Auto-port helper for simple mode + the tunnel wizard: returns the first
  // free source port without creating anything.
  if (searchParams.get("free") === "1") {
    // Advisory only, and deliberately WITHOUT the OS probe: this is a
    // suggestion shown in the form, and binding a socket per candidate on a
    // read-only GET would be needlessly expensive. The authoritative check
    // happens on create, below.
    const port = findFreePort(await collectUsedPorts());
    if (port === null) {
      return apiError(
        new PortRangeExhaustedError(AUTO_PORT_START, AUTO_PORT_END).message,
        409,
      );
    }
    return json({ port });
  }
  const cursor = searchParams.get("cursor") ? { id: searchParams.get("cursor")! } : undefined;
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || LIST_LIMIT, 1), 100);
  const where = auth.user.role === "USER" ? { userId: auth.user.id } : undefined;
  let portForwards;
  try {
    portForwards = await prisma.portForward.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor } : {}),
      select: {
        id: true,
        name: true,
        direction: true,
        protocol: true,
        sourcePort: true,
        destHost: true,
        destPort: true,
        enabled: true,
        status: true,
      },
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2025" || /cursor/i.test((err as Error).message ?? "")) {
      return apiError("Invalid cursor", 400);
    }
    throw err;
  }
  const hasNext = portForwards.length > limit;
  const items = hasNext ? portForwards.slice(0, limit) : portForwards;
  const nextCursor = hasNext ? items[items.length - 1].id : null;
  return json({ rules: items, hasNext, nextCursor });
}

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  // Abuse bound: one authenticated session had no ceiling on this write, and
  // the cost is real server work, not just a database row.
  const rl = rateLimit(`pf-create:${auth.user.id}`, 20, 60000);
  if (!rl.ok) return apiError("Too many requests, slow down", 429);
  const body = await parseBody(request, ruleSchema);
  if (!body.ok) return body.response;

  const hostProblem = await rejectForwardHost(body.data.destHost);
  if (hostProblem) return apiError(hostProblem, 400);

  // Validate pinned node upfront: invalid UUID already rejected by schema,
  // but a well-formed unknown id must 404 instead of Prisma P2003 500.
  if (body.data.nodeId) {
    const node = await prisma.node.findUnique({
      where: { id: body.data.nodeId },
      select: { id: true },
    });
    if (!node) return apiError("Node not found", 404);
  }

  // Automatic mode (default simple flow): allocate the first free port.
  let sourcePort = body.data.sourcePort;
  if (body.data.auto || sourcePort === 0) {
    // Authoritative allocation: consult the database AND the host. A port can
    // be free in the database and already held by an unrelated process, and
    // handing that out produced a generic tunnel failure at deploy time rather
    // than a port conflict the user could act on.
    try {
      sourcePort = await allocatePortAsync(await collectUsedPorts(), {
        isOccupied: isPortOccupied,
      });
    } catch (err) {
      if (err instanceof PortRangeExhaustedError) return apiError(err.message, 409);
      throw err;
    }
  }

  // Fail loudly on collision: two rules (or a tunnel) on the same
  // protocol+port of the same node scope would double-bind at deploy and
  // take down the whole node group. Same port on a different protocol or a
  // different pinned node is fine.
  const clash = await prisma.portForward.findFirst({
    where: {
      protocol: body.data.protocol,
      sourcePort,
      ...(body.data.nodeId
        ? { nodeId: body.data.nodeId }
        : { nodeId: null, direction: body.data.direction }),
    },
    select: { id: true, name: true },
  });
  if (clash) {
    return apiError(
      `Port ${sourcePort}/${body.data.protocol} is already forwarded by "${clash.name}" — pick another port or edit that rule`,
      409,
    );
  }

  // A user-specified port can also be held by a process outside the panel, or
  // by another rule on a different node scope. That is a port conflict, not a
  // generic failure, and it is worth reporting before the rule is created --
  // otherwise the user only finds out when the deploy fails.
  if (await isPortOccupied(sourcePort)) {
    return apiError(
      `Port ${sourcePort}/${body.data.protocol} is already in use by another process on this host — pick another port`,
      409,
    );
  }

  const rule = await prisma.portForward.create({
    data: {
      name: body.data.name,
      userId: auth.user.id,
      direction: body.data.direction,
      protocol: body.data.protocol,
      sourcePort,
      destHost: body.data.destHost,
      destPort: body.data.destPort,
      enabled: body.data.enabled,
      nodeId: body.data.nodeId,
      status: "pending",
    },
  });
  await reconcilePortForwardsSoon();
  await auditLog(auth.user.id, "portforward.create", rule.id, rule.name, getClientIp(request));
  return json({ rule }, 201);
}
