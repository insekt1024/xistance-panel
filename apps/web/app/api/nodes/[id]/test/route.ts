import { prisma } from "@xistance/db";
import { LocalRunner } from "@xistance/tunnel-core";
import { apiError, json, requireSession } from "@/lib/api";
import { nodeToEndpoint } from "@/lib/tunnels";

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const node = await prisma.node.findUnique({ where: { id } });
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
  if (!usePassword) args.push("-o", "BatchMode=yes");
  if (ep.keyPath) args.push("-i", ep.keyPath);
  if (usePassword) args.unshift("sshpass", "-p", ep.password!);
  args.push(`${ep.username ?? "root"}@${ep.host}`, "echo", "ok");

  const res = await runner.run(args);
  if (res.exitCode !== 0) {
    return json({ ok: false, message: res.stderr.trim() || "Unreachable" });
  }
  return json({ ok: true });
}
