import { prisma } from "@xistance/db";

// ---------------------------------------------------------------------------
// Periodic maintenance: prune data that would otherwise grow without bound.
// - AuditLog: kept for AUDIT_RETAIN_DAYS (compliance-friendly default: 90d).
// - Session: expired/revoked rows removed once STALE_SESSION_DAYS have passed.
// Runs hourly alongside the sampler; every step is best-effort.
// ---------------------------------------------------------------------------

const MAINTENANCE_INTERVAL_MS = 60 * 60_000;
const AUDIT_RETAIN_DAYS = 90;
const STALE_SESSION_DAYS = 7;

let started = false;

export function startMaintenance(): void {
  if (started) return;
  started = true;

  const run = async () => {
    const now = Date.now();
    try {
      const auditCutoff = new Date(now - AUDIT_RETAIN_DAYS * 24 * 3600_000);
      const audits = await prisma.auditLog.deleteMany({
        where: { createdAt: { lt: auditCutoff } },
      });
      if (audits.count > 0) {
        console.log(`[maintenance] pruned ${audits.count} audit logs older than ${AUDIT_RETAIN_DAYS}d`);
      }
    } catch {
      /* best effort */
    }
    try {
      const sessionCutoff = new Date(now - STALE_SESSION_DAYS * 24 * 3600_000);
      const sessions = await prisma.session.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: sessionCutoff } },
            { revokedAt: { not: null, lt: sessionCutoff } },
          ],
        },
      });
      if (sessions.count > 0) {
        console.log(`[maintenance] pruned ${sessions.count} stale sessions`);
      }
    } catch {
      /* best effort */
    }
  };

  // First pass shortly after boot (staggered from the sampler's first tick),
  // then hourly.
  const initial = setTimeout(() => void run(), 15_000);
  initial.unref();
  const timer = setInterval(() => void run(), MAINTENANCE_INTERVAL_MS);
  timer.unref();
}
