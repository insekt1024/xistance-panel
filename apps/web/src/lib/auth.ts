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

/**
 * Create a session. `secure` controls the Secure cookie flag: it must only be
 * set when the client actually uses HTTPS, otherwise browsers (and curl)
 * silently drop the cookies and login appears broken over plain HTTP.
 * Defaults to NODE_ENV-based detection for callers without request context.
 */
export async function createSession(user: SafeUser, opts?: { secure?: boolean }): Promise<void> {
  const store = await cookies();
  const useSecure = opts?.secure ?? secure();
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
    secure: useSecure,
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

/**
 * getSession memoisation: RSC pages plus the 30s AutoRefresh re-run getSession on
 * every render/poll. Cache the verified payload for a couple of seconds keyed by
 * the access token so the users table isn't queried dozens of times per minute.
 * Worst-case staleness is SESSION_CACHE_TTL; logout/rotation produce a new token
 * and naturally miss the cache, and destroySession busts the entry explicitly.
 */
const SESSION_CACHE_TTL = 3_000;
const MAX_CACHE_ITEMS = 2_000;
const sessionCache = new Map<string, { at: number; user: SafeUser | null }>();

let lastGcAt = 0;
const GC_INTERVAL_MS = 60_000;

function cacheSession(token: string, user: SafeUser | null): void {
  sessionCache.set(token, { at: Date.now(), user });
  const now = Date.now();
  if (sessionCache.size > MAX_CACHE_ITEMS && now - lastGcAt >= GC_INTERVAL_MS) {
    lastGcAt = now;
    for (const [k, v] of sessionCache) {
      if (now - v.at >= SESSION_CACHE_TTL) sessionCache.delete(k);
    }
  }
}

/** Returns the authenticated user or null. */
export async function getSession(): Promise<SafeUser | null> {
  const store = await cookies();
  const access = store.get(ACCESS_COOKIE)?.value;
  if (!access) return null;
  const hit = sessionCache.get(access);
  if (hit && Date.now() - hit.at < SESSION_CACHE_TTL) return hit.user;
  const payload = verifyJwt(access, getJwtSecret());
  if (!payload) return null;
  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: safeUserSelect,
  });
  const result = user && user.active ? user : null;
  cacheSession(access, result);
  return result;
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
    select: { id: true, userId: true },
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
  const access = store.get(ACCESS_COOKIE)?.value;
  const token = store.get(REFRESH_COOKIE)?.value;
  if (token) {
    await prisma.session.updateMany({
      where: { refreshHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  if (access) sessionCache.delete(access);
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
