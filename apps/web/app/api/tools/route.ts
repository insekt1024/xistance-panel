import net from "node:net";
import { z } from "zod";
import { LocalRunner } from "@xistance/tunnel-core";
import { json, parseBody, requireSession } from "@/lib/api";

const toolSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tcp"), host: z.string().min(1), port: z.number().int().min(1).max(65535) }),
  z.object({ type: z.literal("http"), url: z.string().url() }),
  z.object({ type: z.literal("latency"), host: z.string().min(1) }),
  z.object({ type: z.literal("dns") }),
  z.object({ type: z.literal("censorship") }),
]);

const CENSORED_ENDPOINTS: Array<{ host: string; port: number }> = [
  { host: "www.google.com", port: 443 },
  { host: "github.com", port: 443 },
  { host: "telegram.org", port: 443 },
  { host: "x.com", port: 443 },
  { host: "www.youtube.com", port: 443 },
  { host: "www.instagram.com", port: 443 },
  { host: "whatsapp.com", port: 443 },
  { host: "1.1.1.1", port: 443 },
];

async function tcpProbe(host: string, port: number, timeoutMs = 8000): Promise<{ ok: boolean; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port, timeout: timeoutMs });
    socket.once("connect", () => {
      const ms = Date.now() - started;
      socket.destroy();
      resolve({ ok: true, ms });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ ok: false, ms: Date.now() - started });
    });
    socket.once("error", () => resolve({ ok: false, ms: Date.now() - started }));
  });
}

const runner = new LocalRunner();

export async function POST(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, toolSchema);
  if (!body.ok) return body.response;
  const data = body.data;

  switch (data.type) {
    case "tcp": {
      const res = await tcpProbe(data.host, data.port);
      return json({ ok: true, result: { tcp: { ...res, host: data.host, port: data.port } } });
    }
    case "http": {
      const started = Date.now();
      try {
        const resp = await fetch(data.url, {
          redirect: "follow",
          signal: AbortSignal.timeout(12_000),
        });
        const ms = Date.now() - started;
        await resp.arrayBuffer();
        return json({ ok: true, result: { http: { status: resp.status, ms, ok: resp.ok } } });
      } catch {
        return json({ ok: true, result: { http: { status: 0, ms: Date.now() - started, ok: false } } });
      }
    }
    case "latency": {
      const res = await runner.run(["ping", "-c", "4", "-W", "3", data.host]);
      const avg = /=\s*[\d.]+\/([\d.]+)\/[\d.]+\//.exec(res.stdout)?.[1];
      return json({
        ok: true,
        result: { latency: { avgMs: avg ? Number(avg) : null, reachable: res.exitCode === 0 } },
      });
    }
    case "dns": {
      const res = await runner.run(["nslookup", "example.com"]);
      const ips = [...res.stdout.matchAll(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g)].map(
        (m) => m[1],
      );
      return json({ ok: true, result: { dns: { ips, available: res.exitCode === 0 } } });
    }
    case "censorship": {
      const results = [];
      for (const ep of CENSORED_ENDPOINTS) {
        results.push({ host: ep.host, port: ep.port, ...(await tcpProbe(ep.host, ep.port)) });
      }
      const blocked = results.filter((r) => !r.ok).length;
      return json({
        ok: true,
        result: {
          censorship: { hosts: results, likelyCensored: blocked > 0, blockedCount: blocked },
        },
      });
    }
  }
}
