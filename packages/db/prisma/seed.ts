import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { prisma } from "../src/index.js";

// ---------------------------------------------------------------------------
// Seed: creates the initial Super Admin and, when XT_DEMO=true, sample nodes,
// tunnels and port-forward rules so the UI is explorable immediately.
//
//   npm run seed          # admin + demo data (demo only when XT_DEMO=true)
//   npm run seed -- --reset  # wipe tables first (idempotent-ish)
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:16384:8:1:${salt.toString("base64")}:${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, nStr, rStr, pStr, saltB64, hashB64] = stored.split(":");
  if (algo !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function main() {
  const reset = process.argv.includes("--reset");
  if (reset) {
    await prisma.trafficSample.deleteMany();
    await prisma.portForward.deleteMany();
    await prisma.tunnel.deleteMany();
    await prisma.node.deleteMany();
    await prisma.session.deleteMany();
    await prisma.apiKey.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.notificationWebhook.deleteMany();
    await prisma.setting.deleteMany();
    await prisma.user.deleteMany();
    console.log("↺  Reset complete");
  }

  const email = process.env.XT_ADMIN_EMAIL ?? "admin@xistance.local";
  const password = process.env.XT_ADMIN_PASSWORD ?? "xistance-admin";

  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    await prisma.user.create({
      data: {
        email,
        name: "Super Admin",
        passwordHash: hashPassword(password),
        role: "SUPER_ADMIN",
      },
    });
    console.log(`✓  Created super admin: ${email}`);
  } else {
    console.log(`✓  Super admin already exists: ${email}`);
  }

  if (process.env.XT_DEMO === "true") {
    await seedDemo();
  }
  console.log("Seeding complete.");
}

async function seedDemo() {
  const foreign = await prisma.node.upsert({
    where: { name_type: { name: "Demo Foreign", type: "FOREIGN" } },
    update: {},
    create: {
      name: "Demo Foreign",
      type: "FOREIGN",
      host: "203.0.113.10",
      sshPort: 22,
      sshUser: "root",
      status: "online",
    },
  });
  const iran = await prisma.node.upsert({
    where: { name_type: { name: "Demo Iran", type: "IRAN" } },
    update: {},
    create: {
      name: "Demo Iran",
      type: "IRAN",
      host: "192.168.1.10",
      sshPort: 22,
      sshUser: "root",
      status: "online",
    },
  });

  await prisma.tunnel.upsert({
    where: { id: "demo-backhaul" },
    update: {},
    create: {
      id: "demo-backhaul",
      name: "Demo Backhaul",
      method: "BACKHAUL",
      status: "stopped",
      state: "stopped",
      clientNodeId: iran.id,
      serverNodeId: foreign.id,
      port: 3080,
      config: {
        method: "BACKHAUL",
        backhaul: {
          role: "client",
          transport: "tcp",
          listenPort: 3080,
          remoteHost: foreign.host,
          token: "demo-token",
          portMap: [{ local: 8080, remote: 8080 }],
        },
      },
    },
  });

  await prisma.portForward.create({
    data: {
      name: "Demo SSH",
      direction: "IRAN_TO_FOREIGN",
      protocol: "tcp",
      sourcePort: 22022,
      destHost: foreign.host,
      destPort: 22,
      enabled: true,
    },
  });

  console.log("✓  Demo nodes + tunnel + rule seeded (XT_DEMO=true)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
