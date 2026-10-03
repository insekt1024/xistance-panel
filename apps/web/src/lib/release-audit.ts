/**
 * Update / migration / rollback / recovery audit records (TASK-39).
 *
 * The panel's own actions (tunnels, nodes, users) already reach the audit
 * trail. The actions an OPERATOR performs on the running installation did not:
 * an update, a migration, a readiness probe, a rollback, and a restore all
 * change what is deployed, and none of them were recorded. After an incident
 * the first question is "what changed, when, and did it work" — and none of
 * those had an answer.
 *
 * No new table. The existing `AuditLog` (actorId / action / target / details /
 * ip / createdAt, with indexes on actorId+createdAt, createdAt, and action)
 * already represents the event; what was missing was a caller. Adding a table
 * would require separate migration evidence for no representational gain.
 *
 * Two rules make these records trustworthy rather than merely present:
 *
 *   1. **Record the outcome, not the attempt.** A record is written only once
 *      the action's result is known. An audit row written before the work says
 *      "update.started" and the process is then killed -- the trail claims an
 *      update happened, and the operator has no way to tell which half.
 *
 *   2. **Allowlisted fields, bounded categories.** Only a fixed set of keys is
 *      ever serialised, and an error is reduced to a CATEGORY from a closed set.
 *      A raw error message carries file paths, SQL fragments, argv and
 *      occasionally credentials, all of which would land in a table an admin can
 *      read. The full message goes to the service log, where it belongs.
 */

import { auditLog } from "./api";

/**
 * Release-lifecycle actions, named to match the existing `noun.verb` convention
 * (`tunnel.create`, `user.delete`, `webhook.update`).
 *
 * The `.failed` suffix on a started action is what makes an incomplete attempt
 * distinguishable from a completed one: `update.ok` means the new release is
 * serving, `update.failed` means it is not, and the absence of either means the
 * process died mid-update — which is itself the most important thing to know.
 */
export const RELEASE_ACTIONS = {
  update: "release.update",
  updateFailed: "release.update.failed",
  migration: "release.migration",
  migrationFailed: "release.migration.failed",
  readiness: "release.readiness",
  readinessFailed: "release.readiness.failed",
  rollback: "release.rollback",
  rollbackFailed: "release.rollback.failed",
  restore: "release.restore",
  restoreFailed: "release.restore.failed",
} as const;

export type ReleaseAction = (typeof RELEASE_ACTIONS)[keyof typeof RELEASE_ACTIONS];

/**
 * Closed set of failure categories.
 *
 * An error is mapped to one of these before it is stored. The raw message is
 * deliberately NOT persisted: a Prisma or SQLite error can embed a file path, a
 * fragment of SQL, or — when a command line is involved — an argument that is a
 * password. Keeping the category gives an operator the thing they actually
 * filter on ("was it the migration, the readiness probe, or the disk?") without
 * giving them a second copy of the secrets already in the service log.
 */
export const ERROR_CATEGORIES = [
  "migration-failed",
  "readiness-timeout",
  "activation-failed",
  "backup-missing",
  "backup-corrupt",
  "permission-denied",
  "disk-full",
  "network-unreachable",
  "cancelled",
  "unknown",
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/**
 * Reduce an arbitrary thrown value to a bounded category.
 *
 * Matches on the message, because that is all that is available from a caught
 * `unknown`, and falls back to `unknown` rather than inventing a category. The
 * caller logs the full error separately.
 */
export function classifyError(err: unknown): ErrorCategory {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (msg.includes("wal_checkpoint") || msg.includes("vacuum")) return "migration-failed";
  if (msg.includes("migration") || msg.includes("prisma") || msg.includes("sql")) return "migration-failed";
  if (msg.includes("timed out") || msg.includes("timeout") || msg.includes("health")) return "readiness-timeout";
  if (msg.includes("activat") || msg.includes("cutover") || msg.includes("symlink")) return "activation-failed";
  if (msg.includes("checksum") || msg.includes("corrupt") || msg.includes("digest")) return "backup-corrupt";
  if (msg.includes("no such file") && msg.includes("backup")) return "backup-missing";
  if (msg.includes("permission") || msg.includes("eacces") || msg.includes("denied")) return "permission-denied";
  if (msg.includes("no space") || msg.includes("enospc") || msg.includes("disk full")) return "disk-full";
  if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("network")) return "network-unreachable";
  if (msg.includes("cancel") || msg.includes("abort")) return "cancelled";
  return "unknown";
}

/**
 * Keys that may appear in a stored `details` string. Anything else is dropped.
 *
 * The version and outcome are the two things an operator filters on during an
 * incident; the rest is context. An allowlist rather than a denylist, because a
 * denylist of "password" and "token" misses `--private-key`, `DATABASE_URL`,
 * `authorization`, and whatever the next caller invents.
 */
type DetailKey = "version" | "from" | "to" | "outcome" | "errorCategory" | "release" | "attempts";

export interface ReleaseEvent {
  action: ReleaseAction;
  version?: string | null;
  from?: string | null;
  to?: string | null;
  outcome: "ok" | "failed" | "attempted";
  errorCategory?: ErrorCategory;
  attempts?: number;
  actorId?: string | null;
  ip?: string | null;
}

/** Truncate a value so a pathological input cannot bloat the table. */
function clip(v: unknown, max = 64): string {
  const s = String(v ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Serialise the allowlisted fields into the flat `details` string the existing
 * schema stores. Deterministic key order keeps the rows comparable in the UI
 * and in tests.
 */
export function formatReleaseDetails(ev: ReleaseEvent): string {
  const fields: Array<[DetailKey, unknown]> = [
    ["version", ev.version],
    ["from", ev.from],
    ["to", ev.to],
    ["outcome", ev.outcome],
    ["errorCategory", ev.errorCategory],
    ["attempts", ev.attempts],
  ];
  const parts = fields
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${clip(v)}`);
  return parts.join(" ");
}

/**
 * Actions whose records must outlive the ordinary audit retention window.
 *
 * `maintenance.ts` prunes AuditLog rows older than 90 days. That is right for
 * day-to-day actions, but a release record is evidence of what was deployed on a
 * host: an operator investigating "what version has this box been on for six
 * months?" needs the update and rollback history, and the prune would have
 * removed exactly the rows that answer it. Exported so the prune can exclude
 * them by action rather than by extending everyone's retention.
 */
export const RETAINED_RELEASE_ACTIONS: readonly string[] = Object.values(RELEASE_ACTIONS);

/**
 * Record a release-lifecycle event.
 *
 * `actorId` is null for actions the operator performed on the host rather than
 * through the panel (running `update.sh` over SSH is the normal case), which is
 * why the column is nullable — an unattributed system action is real
 * information, and inventing a user id for it would be a lie.
 */
export async function recordReleaseEvent(ev: ReleaseEvent): Promise<void> {
  const details = formatReleaseDetails(ev);
  // `target` is the version, so an operator can filter the audit view by it
  // with the existing target column rather than parsing a free-text string.
  await auditLog(ev.actorId ?? null, ev.action, ev.version ?? undefined, details, ev.ip ?? null);
}

/**
 * Convenience wrappers that make the call sites read as the event they record,
 * and that force the caller to state the outcome explicitly.
 */
export const releaseAudit = {
  updated: (v: { version?: string | null; from?: string | null; actorId?: string | null; ip?: string | null }) =>
    recordReleaseEvent({ action: RELEASE_ACTIONS.update, outcome: "ok", ...v }),

  updateFailed: (v: {
    version?: string | null;
    from?: string | null;
    error: unknown;
    attempts?: number;
    actorId?: string | null;
    ip?: string | null;
  }) => {
    // The full error goes to the service log; only the category is persisted.
    console.error(`[release] update failed for ${v.version ?? "?"}:`, v.error);
    return recordReleaseEvent({
      action: RELEASE_ACTIONS.updateFailed,
      outcome: "failed",
      errorCategory: classifyError(v.error),
      attempts: v.attempts,
      version: v.version,
      from: v.from,
      actorId: v.actorId,
      ip: v.ip,
    });
  },

  migrated: (v: { version?: string | null; actorId?: string | null; ip?: string | null }) =>
    recordReleaseEvent({ action: RELEASE_ACTIONS.migration, outcome: "ok", ...v }),

  migrationFailed: (v: { version?: string | null; error: unknown; actorId?: string | null; ip?: string | null }) => {
    console.error(`[release] migration failed for ${v.version ?? "?"}:`, v.error);
    return recordReleaseEvent({
      action: RELEASE_ACTIONS.migrationFailed,
      outcome: "failed",
      errorCategory: classifyError(v.error),
      version: v.version,
      actorId: v.actorId,
      ip: v.ip,
    });
  },

  readinessFailed: (v: { version?: string | null; error: unknown; actorId?: string | null; ip?: string | null }) => {
    console.error(`[release] readiness failed for ${v.version ?? "?"}:`, v.error);
    return recordReleaseEvent({
      action: RELEASE_ACTIONS.readinessFailed,
      outcome: "failed",
      errorCategory: classifyError(v.error),
      version: v.version,
      actorId: v.actorId,
      ip: v.ip,
    });
  },

  rolledBack: (v: { from?: string | null; to?: string | null; actorId?: string | null; ip?: string | null }) =>
    recordReleaseEvent({ action: RELEASE_ACTIONS.rollback, outcome: "ok", from: v.from, to: v.to, actorId: v.actorId, ip: v.ip }),

  rollbackFailed: (v: {
    from?: string | null;
    to?: string | null;
    error: unknown;
    actorId?: string | null;
    ip?: string | null;
  }) => {
    console.error(`[release] rollback failed (${v.from ?? "?"} -> ${v.to ?? "?"}):`, v.error);
    return recordReleaseEvent({
      action: RELEASE_ACTIONS.rollbackFailed,
      outcome: "failed",
      errorCategory: classifyError(v.error),
      from: v.from,
      to: v.to,
      actorId: v.actorId,
      ip: v.ip,
    });
  },

  restored: (v: { version?: string | null; archive?: string | null; actorId?: string | null; ip?: string | null }) =>
    recordReleaseEvent({ action: RELEASE_ACTIONS.restore, outcome: "ok", version: v.archive ?? v.version, actorId: v.actorId, ip: v.ip }),

  restoreFailed: (v: { error: unknown; actorId?: string | null; ip?: string | null }) => {
    console.error("[release] restore failed:", v.error);
    return recordReleaseEvent({
      action: RELEASE_ACTIONS.restoreFailed,
      outcome: "failed",
      errorCategory: classifyError(v.error),
      actorId: v.actorId,
      ip: v.ip,
    });
  },
};
