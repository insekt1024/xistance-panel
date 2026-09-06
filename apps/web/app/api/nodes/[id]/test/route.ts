import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@xistance/db";
import { LocalRunner } from "@xistance/tunnel-core";
import { apiError, json, requireSession } from "@/lib/api";
import { nodeToEndpoint } from "@/lib/tunnels";
import { rateLimit } from "@/lib/rate-limit";

const execFileAsync = promisify(execFile);

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;
  // SSH probes spawn processes with 10s timeouts; cap per-user usage.
  const rl = rateLimit(`node-test:${auth.user.id}`, 10, 60_000);
  if (!rl.ok) return apiError("Too many connection tests, try again shortly", 429);
  const { id } = await ctx.params;
  const node = await prisma.node.findUnique({
    where: { id },
    select: { id: true, host: true, sshUser: true, sshPort: true, authMethod: true, sshKeyEncrypted: true, sshPasswordEnc: true },
  });
  if (!node) return apiError("Node not found", 404);

  const ep = await nodeToEndpoint(node);
  const runner = new LocalRunner();
  const args: string[] = [
    "ssh",
    "-p",
    String(ep.sshPort ?? 22),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
  ];
  const usePassword = ep.authMethod === "password" && Boolean(ep.password);
  if (usePassword) {
    try {
      await execFileAsync("which", ["sshpass"]);
    } catch {
      return apiError("sshpass is not installed on this server. Install it to use password authentication.", 500);
    }
  }
  if (!usePassword) args.push("-o", "BatchMode=yes");
  if (ep.keyPath) args.push("-i", ep.keyPath);
  if (usePassword) args.unshift("sshpass", "-e");
  args.push(`${ep.username ?? "root"}@${ep.host}`, "echo", "ok");

  const res = usePassword && ep.password
    ? await runner.run(args, { env: { SSHPASS: ep.password } })
    : await runner.run(args);
  if (res.exitCode !== 0) {
    return json({ ok: false, message: res.stderr.trim() || "Unreachable" });
  }
  return json({ ok: true });
}
