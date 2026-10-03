import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prisma } from "@xistance/db";
import { assertSafeSshDestination, LocalRunner, sanitizeForDiagnostics } from "@xistance/tunnel-core";
import { apiError, json, requireSession } from "@/lib/api";
import { nodeToEndpoint } from "@/lib/tunnels";
import { rateLimit } from "@/lib/rate-limit";

const execFileAsync = promisify(execFile);

/**
 * Turn an SSH failure into a message that is safe to render.
 *
 * `ssh` stderr is not a status line: it can contain the resolved target host,
 * key fingerprints, a local filesystem path, the identity file that was tried,
 * and occasionally the key material path plus a base64 blob. Returning it
 * verbatim to an admin-only browser endpoint hands the page whatever the local
 * ssh client felt like printing. Map the failure to a known reason instead, and
 * keep the detail in the server log where it belongs.
 */
function sshFailureMessage(stderr: string, exitCode: number): string {
  const s = stderr.toLowerCase();
  if (/permission denied|could not read passphrase|authentication failed/.test(s)) {
    return "Authentication failed. Check the username and credentials for this node.";
  }
  if (/host key verification failed/.test(s)) return "Host key verification failed for this node.";
  if (/connection refused/.test(s)) return "Connection refused: nothing is listening on that port.";
  if (/no route to host|network is unreachable/.test(s)) return "Host unreachable from this server.";
  if (/could not resolve hostname|name or service not known|temporary failure/.test(s)) {
    return "Hostname could not be resolved from this server.";
  }
  if (/connection timed out|operation timed out/.test(s)) return "Connection timed out.";
  if (/sshpass/.test(s) && /not found|no such file/.test(s)) {
    return "sshpass is not installed on this server, so password authentication is unavailable.";
  }
  return `SSH connection failed (exit ${exitCode}).`;
}

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

  // The destination token below is `${username}@${host}`. ssh parses ANY argv
  // token beginning with "-" as an OPTION before it looks for a destination, so
  // a stored username of `-oProxyCommand=<cmd>` made ssh execute that command
  // on the panel host — a real RCE, reproduced by running the local ssh. The
  // node schema now refuses such a username, but a node row created before
  // that fix is still in the database, and this route is the shortest path to
  // it. Refuse here too: returning a 400 is correct, not a crash, because the
  // value is data.
  const sshUsername = ep.username ?? "root";
  try {
    assertSafeSshDestination(sshUsername, ep.host);
  } catch (err) {
    return apiError(
      `This node has an unsafe SSH username or host and cannot be probed: ${(err as Error).message}`,
      400,
    );
  }
  args.push(`${sshUsername}@${ep.host}`, "echo", "ok");

  const res = usePassword && ep.password
    ? await runner.run(args, { env: { SSHPASS: ep.password } })
    : await runner.run(args);
  if (res.exitCode !== 0) {
    // The sanitised reason goes to the browser; the raw stderr goes to the log.
    const message = sshFailureMessage(res.stderr, res.exitCode);
    console.warn(
      `[node-test] ${ep.host}:${ep.sshPort ?? 22} failed: ${sanitizeForDiagnostics(res.stderr.trim()).slice(0, 500)}`,
    );
    return json({ ok: false, message });
  }
  return json({ ok: true });
}
