import { prisma } from "@xistance/db";
import { AuditView } from "./audit-view";

export const dynamic = "force-dynamic";

const LIST_LIMIT = 50;

export default async function AuditPage() {
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: LIST_LIMIT,
    select: {
      id: true,
      actorId: true,
      action: true,
      target: true,
      details: true,
      ip: true,
      createdAt: true,
      actor: { select: { id: true, name: true, email: true } },
    },
  });

  const hasNext = logs.length === LIST_LIMIT;
  const nextCursor = hasNext ? logs[logs.length - 1].id : null;

  return (
    <AuditView
      initialLogs={logs as unknown as Parameters<typeof AuditView>[0]["initialLogs"]}
      initialHasNext={hasNext}
      initialNextCursor={nextCursor}
    />
  );
}
