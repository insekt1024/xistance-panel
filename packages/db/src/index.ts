import { PrismaClient } from "../generated/client/index.js";
import path from "node:path";

// ---------------------------------------------------------------------------
// Prisma client singleton with a sane DATABASE_URL default for development.
// install.sh exports an absolute DATABASE_URL in production.
// ---------------------------------------------------------------------------

function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const dir = process.env.XT_DATA_DIR ?? path.join(process.cwd(), ".data");
  return `file:${path.join(dir, "xistance.db")}`;
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasources: {
      db: { url: resolveDatabaseUrl() },
    },
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export * from "../generated/client/index.js";
