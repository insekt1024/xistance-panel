import { z } from "zod";
import { prisma } from "@xistance/db";
import { hashPassword } from "@xistance/tunnel-core";
import { apiError, auditLog, getClientIp, json, parseBody, requireSession } from "@/lib/api";

const userUpdateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  role: z.enum(["USER", "ADMIN", "SUPER_ADMIN"]).optional(),
  quota: z.number().int().min(0).max(1000).optional(),
  password: z.string().min(8).optional(),
  active: z.boolean().optional(),
});

export async function PUT(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(request, "ADMIN");
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const existing = await prisma.user.findUnique({ where: { id }, select: { role: true, email: true } });
  if (!existing) return apiError("User not found", 404);

  const body = await parseBody(request, userUpdateSchema);
  if (!body.ok) return body.response;
  const data = body.data;

  // Prevent demoting the last super admin to a non-admin role.
  if (data.role && data.role !== "SUPER_ADMIN" && existing.role === "SUPER_ADMIN") {
    const superAdmins = await prisma.user.count({ where: { role: "SUPER_ADMIN" } });
    if (superAdmins <= 1) return apiError("Cannot demote the last super admin", 400);
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      name: data.name,
      role: data.role,
      quota: data.quota,
      active: data.active,
      passwordHash: data.password ? hashPassword(data.password) : undefined,
    },
    select: { id: true, email: true },
  });
  await auditLog(auth.user.id, "user.update", id, user.email, getClientIp(request));
  return json({ user: { id: user.id, email: user.email } });
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireSession(request, "SUPER_ADMIN");
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (id === auth.user.id) return apiError("You cannot delete yourself", 400);
  const existing = await prisma.user.findUnique({ where: { id }, select: { email: true } });
  if (!existing) return apiError("User not found", 404);
  await prisma.user.delete({ where: { id } });
  await auditLog(auth.user.id, "user.delete", id, existing.email, getClientIp(request));
  return json({ ok: true });
}
