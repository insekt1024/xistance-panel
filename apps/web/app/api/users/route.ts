import { z } from "zod";
import { prisma } from "@xistance/db";
import { hashPassword, randomPassword } from "@xistance/tunnel-core";
import { apiError, auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";

const userCreateSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(80),
  role: z.enum(["USER", "ADMIN", "SUPER_ADMIN"]).default("USER"),
  quota: z.number().int().min(0).max(1000).default(5),
  password: z.string().min(8).optional(),
  active: z.boolean().default(true),
});

export async function GET(request: Request) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      quota: true,
      active: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return json({ users });
}

export async function POST(request: Request) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;
  const body = await parseBody(request, userCreateSchema);
  if (!body.ok) return body.response;
  const data = body.data;

  const existing = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
  if (existing) return apiError("Email already in use", 409);

  const password = data.password ?? randomPassword();
  const user = await prisma.user.create({
    data: {
      email: data.email.toLowerCase(),
      name: data.name,
      role: data.role,
      quota: data.quota,
      passwordHash: hashPassword(password),
      active: data.active,
    },
  });
  await auditLog(auth.user.id, "user.create", user.id, user.email, getClientIp(request));
  return json({ user: { id: user.id, email: user.email, generatedPassword: password } }, 201);
}
