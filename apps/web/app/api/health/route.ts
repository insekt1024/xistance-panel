import { prisma } from "@xistance/db";
import { getEngine } from "@/lib/engine";
import { json } from "@/lib/api";
import { APP_VERSION as version } from "@/lib/version";

export const dynamic = "force-dynamic";

// Lightweight liveness/readiness probe for uptime monitors and the
// install/update scripts. Reports DB reachability and engine size without
// requiring authentication (contains no sensitive data).
export async function GET() {
  const checks: Record<string, string> = {};
  let ok = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch {
    checks.database = "unreachable";
    ok = false;
  }

  try {
    const engine = getEngine();
    checks.engine = "ok";
    checks.managedTunnels = String(engine.size());
  } catch {
    checks.engine = "unavailable";
  }

  return json({ ok, status: ok ? "healthy" : "degraded", version, checks }, ok ? 200 : 503);
}
