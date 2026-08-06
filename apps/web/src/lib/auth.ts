import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { prisma, type User } from "@xistance/db";
import { randomBytesHex, randomToken } from "@xistance/tunnel-core";
import { signJwt, verifyJwt } from "./jwt";

// ---------------------------------------------------------------------------
// Session management: short-lived JWT access token + rotating opaque refresh
// token (stored hashed). All cookies httpOnly + sameSite=Lax; CSRF uses a
// double-submit cookie read by the client.
// ---------------------------------------------------------------------------

const ACCESS_TTL_S = 15 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const ACCESS_COOKIE = "xt_access";
const REFRESH_COOKIE = "xt_refresh";
const CSRF_COOKIE = "xt_csrf";

export function getJwtSecret(): string {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is not set. Generate one with `openssl rand -hex 32`.");
  }
  return "dev-only-jwt-secret";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const secure = () => process.env.NODE_ENV === "production";

export const safeUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  quota: true,
  locale: true,
  active: true,
  createdAt: true,
} as const;

export type SafeUser = Pick<
  User,
  "id" | "email" | "name" | "role" | "quota" | "locale" | "active" | "createdAt"
>;

export async function createSession(user: SafeUser): Promise<void> {
  const store = await cookies();
  const refresh = randomToken(48);
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refresh),
      refreshHash: hashToken(refresh),
      expiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000),
    },
  });
  const access = signJwt(
    { sub: user.id, email: user.email, role: user.role, jti: randomBytesHex(8) },
    getJwtSecret(),
    ACCESS_TTL_S,
  );
  const csrf = randomToken(24);
  const common = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: secure(),
    path: "/",
  };
  store.set(ACCESS_COOKIE, access, { ...common, maxAge: ACCESS_TTL_S });
  store.set(REFRESH_COOKIE, refresh, { ...common, maxAge: REFRESH_TTL_S });
  store.set(CSRF_COOKIE, csrf, {
    ...common,
    httpOnly: false,
    maxAge: REFRESH_TTL_S,
  });
}

/** Returns the authenticated user or null. */
export async function getSession(): Promise<SafeUser | null> {
  const store = await cookies();
  const access = store.get(ACCESS_COOKIE)?.value;
  if (!access) return null;
  const payload = verifyJwt(access, getJwtSecret());
  if (!payload) return null;
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: safeUserSelect,
  });
  if (!user || !user.active) return null;
  return user;
}

/** Server-component guard: returns the user or throws a redirect to login. */
export async function requireUser(): Promise<SafeUser> {
  const user = await getSession();
  if (!user) {
    const { getLocale } = await import("next-intl/server");
    const { redirect } = await import("@/i18n/routing");
    redirect({ href: "/login", locale: await getLocale() });
    throw new Error("redirect");
  }
  return user;
}

/** Rotate the refresh token when the access token is expired/missing. */
export async function refreshSession(): Promise<SafeUser | null> {  const store = await cookies();
  const token = store.get(REFRESH_COOKIE)?.value;
  if (!token) return null;
  const hash = hashToken(token);
  const session = await prisma.session.findFirst({
    where: {
      refreshHash: hash,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });
  if (!session) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: safeUserSelect,
  });
  if (!user || !user.active) return null;
  await prisma.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });
  await createSession(user);
  return user;
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(REFRESH_COOKIE)?.value;
  if (token) {
    await prisma.session.updateMany({
      where: { refreshHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
  store.delete(CSRF_COOKIE);
}

/** Double-submit CSRF check for state-changing requests. */
export function assertCsrf(request: Request): boolean {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const match = new RegExp(`${CSRF_COOKIE}=([^;]+)`).exec(cookieHeader);
  const header = request.headers.get("x-csrf-token");
  if (!match || !header) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Origin check: disallow cross-site state-changing requests. */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // same-origin non-browser clients are fine
  const url = new URL(request.url);
  try {
    const o = new URL(origin);
    return o.host === url.host;
  } catch {
    return false;
  }
}
