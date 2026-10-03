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
/** How long a just-rotated refresh token keeps working (parallel requests). */
const REFRESH_GRACE_MS = 30_000;

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

/**
 * Did this request actually arrive over HTTPS?
 *
 * Secure cookies are dropped by clients on plain HTTP, and the panel's
 * documented default is http://<server-ip>:8080 — so getting this wrong logs
 * everyone out. `request.url` is rebuilt from the server's bind address and
 * is effectively never https here, so the forwarded header is what decides it
 * behind a TLS-terminating proxy.
 */
export function requestIsHttps(request: Request): boolean {
  if (process.env.XT_TRUST_PROXY === "true") {
    const proto = request.headers.get("x-forwarded-proto");
    if (proto) return proto.split(",")[0].trim().toLowerCase() === "https";
  }
  try {
    return new URL(request.url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Rotate the refresh token when the access token is expired/missing.
 *
 * `secure` MUST reflect the request scheme. This used to fall through to the
 * NODE_ENV default, so a production panel on plain HTTP reissued Secure
 * cookies that the browser discarded — and because the old session is revoked
 * first, that left the user with no valid refresh token at all.
 */
export async function refreshSession(opts?: { secure?: boolean }): Promise<SafeUser | null> {
  const store = await cookies();
  const token = store.get(REFRESH_COOKIE)?.value;
  if (!token) return null;
  const hash = hashToken(token);
  // Requests that arrive together after an expiry all carry the same refresh
  // cookie. The first rotates it; without a grace window the rest would find
  // it revoked and 401, so an idle tab would log itself out on its next burst
  // of parallel fetches. Nothing here implements reuse detection, so a short
  // window costs no security property that existed before.
  const graceFrom = new Date(Date.now() - REFRESH_GRACE_MS);
  const session = await prisma.session.findFirst({
    where: {
      refreshHash: hash,
      expiresAt: { gt: new Date() },
      OR: [{ revokedAt: null }, { revokedAt: { gt: graceFrom } }],
    },
    orderBy: { createdAt: "desc" },
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
  await createSession(user, opts);
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

/** Longest cookie header we will scan; anything larger is not a browser. */
const MAX_COOKIE_HEADER = 8 * 1024;

/** Read one cookie by exact name, with a left boundary. */
function readCookie(cookieHeader: string, name: string): string | null {
  if (cookieHeader.length > MAX_COOKIE_HEADER) return null;
  // Split on ";" and compare the part BEFORE "=" exactly. A regex like
  // `xt_csrf=([^;]+)` has no left boundary, so a cookie named `xxt_csrf` or
  // `evilxt_csrf` satisfied the CSRF check.
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

/** Double-submit CSRF check for state-changing requests. */
export function assertCsrf(request: Request): boolean {
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookie = readCookie(cookieHeader, CSRF_COOKIE);
  const header = request.headers.get("x-csrf-token");
  if (!cookie || !header) return false;
  const a = Buffer.from(cookie);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The protocol of `request.url`, or null when it cannot be determined.
 *
 * Split out so the caller can ask "do we actually know the scheme?" without
 * inventing an http:// answer. Returning "http:" on a parse failure is right for
 * a security decision (fail closed) and wrong for a freshness check (it looks
 * like a real observation), so the two callers get different signals.
 */
function safeRequestProtocol(request: Request): string | null {
  try {
    const p = new URL(request.url).protocol;
    return p === "https:" ? "https:" : p === "http:" ? "http:" : null;
  } catch {
    return null;
  }
}

/**
 * Whether a trusted proxy actually told us the scheme.
 *
 * "XT_TRUST_PROXY is set" is not the same claim as "the scheme is known": the
 * flag says a sanitising proxy sits in front, while this asks whether that
 * proxy sent X-Forwarded-Proto. A proxy that rewrites Host but omits Proto
 * leaves the scheme unknown, and treating it as the server's own http:// is what
 * made originAllowed reject same-origin https traffic. Reading the header
 * separately keeps "am I allowed to trust this header" and "did I receive it"
 * as two independent questions.
 */
function forwardedProtoIsPresent(request: Request): boolean {
  const raw = request.headers.get("x-forwarded-proto");
  if (raw === null) return false;
  const first = raw.split(",")[0]?.trim().toLowerCase() ?? "";
  return first === "https" || first === "http";
}

/**
 * Scheme the request actually arrived on.
 *
 * Mirrors requestHost: `request.url` is rebuilt by the standalone server from
 * its own bind address, so the forwarded proto is the only honest signal
 * behind a TLS-terminating proxy -- and, like the forwarded host, it is
 * attacker-controlled unless the operator opted in.
 */
function requestScheme(request: Request): string {
  if (process.env.XT_TRUST_PROXY === "true") {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (proto === "https") return "https:";
    if (proto === "http") return "http:";
  }
  return safeRequestProtocol(request) ?? "http:";
}

/**
 * Host the client actually addressed.
 *
 * NOT `request.url`: the Next standalone server rebuilds that from its own
 * bind address (install.sh sets HOSTNAME=0.0.0.0), so it carries the internal
 * host, never the one the browser typed. Comparing an Origin against it
 * rejects every browser request — including plain loopback — while letting
 * non-browser clients (which send no Origin) straight through.
 */
function requestHost(request: Request): string | null {
  // X-Forwarded-Host is attacker-controlled unless a sanitising proxy sits in
  // front, so it is gated on the same opt-in getClientIp() uses for
  // X-Forwarded-For.
  if (process.env.XT_TRUST_PROXY === "true") {
    const fwd = request.headers.get("x-forwarded-host");
    if (fwd) {
      const first = fwd.split(",")[0].trim();
      if (first) return first.toLowerCase();
    }
  }
  const host = request.headers.get("host")?.trim();
  return host ? host.toLowerCase() : null;
}

/**
 * Extra origins accepted regardless of Host — for deployments where the
 * public origin genuinely differs from the Host the app receives (TLS
 * terminated on another name, separate admin domain). Comma-separated, either
 * full origins (https://panel.example) or bare hosts (panel.example:8443).
 */
const MAX_ALLOWED_ORIGINS = 16;
const MAX_ALLOWED_ORIGIN_LEN = 200;

/**
 * Parse XT_ALLOWED_ORIGINS into a bounded, validated set.
 *
 * The previous version comma-split with no cap and no validation, so a typo
 * could store `javascript:alert(1)`, `null` or `*` verbatim -- and a paste of
 * 5000 hosts became a 5000-entry allowlist compared on every state-changing
 * request. Entries are now validated as an origin (scheme://host[:port]) or a
 * bare host[:port], length-capped and count-capped, and anything else is
 * dropped with a warning rather than honoured.
 */
function allowedOrigins(): Set<string> {
  return allowedOriginsForTest(process.env.XT_ALLOWED_ORIGINS ?? "");
}

/**
 * The allowlist parser, taking the raw string directly.
 *
 * Exported so the STORE can be asserted in tests: several malformed entries
 * (`javascript:`, `file:`, `*`) can never match behaviourally, because the
 * origin scheme gate rejects them first. A request-level assertion alone
 * therefore does not prove such an entry was dropped at parse time -- a
 * regression that stored it verbatim would survive. The parameterised form
 * keeps that observable without mutating process.env from a test.
 */
export function allowedOriginsForTest(raw: string): Set<string> {
  const out = new Set<string>();
  for (const part of raw.split(",")) {
    if (out.size >= MAX_ALLOWED_ORIGINS) {
      console.warn(`[auth] XT_ALLOWED_ORIGINS: ignoring entries past ${MAX_ALLOWED_ORIGINS}`);
      break;
    }
    const entry = part.trim().toLowerCase();
    if (!entry) continue;
    if (entry.length > MAX_ALLOWED_ORIGIN_LEN) {
      console.warn(`[auth] XT_ALLOWED_ORIGINS: ignoring an entry longer than ${MAX_ALLOWED_ORIGIN_LEN} chars`);
      continue;
    }
    // "null" is all letters, so the bare-host shape below happily accepts it --
    // and "null" is exactly the Origin a sandboxed iframe sends. It must never
    // be reachable as a stored allowlist entry.
    if (entry === "null") {
      console.warn("[auth] XT_ALLOWED_ORIGINS: ignoring the \"null\" token");
      continue;
    }
    // A bare host, optionally with a port. A single label with no dot is not a
    // resolvable public host either, but it is harmless here, so it stays
    // allowed; the null token is the one that must be refused.
    if (/^[a-z0-9.-]+(?::\d{1,5})?$/.test(entry)) {
      out.add(entry);
      continue;
    }
    // A full origin: scheme://host[:port], with no path, query or fragment.
    if (/^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/.test(entry)) {
      out.add(entry);
      continue;
    }
    console.warn(`[auth] XT_ALLOWED_ORIGINS: ignoring a malformed entry (${entry.slice(0, 40)})`);
  }
  return out;
}

/** Schemes an Origin is ever allowed to use. */
const ORIGIN_SCHEMES = new Set(["http:", "https:"]);

/** Origin check: disallow cross-site state-changing requests. */
export function originAllowed(request: Request): boolean {
  const origin = request.headers.get("origin");
  // Absent is fine (a non-browser client sends none). PRESENT BUT EMPTY is not:
  // `if (!origin)` conflated the two, so `Origin:` with an empty value was
  // treated as "no Origin" and waved through.
  if (origin === null) return true;
  if (origin.trim() === "") return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false; // malformed Origin
  }
  // "null" parses as a URL with no host (a sandboxed iframe), and javascript:
  // / data: never legitimately address this panel.
  if (!ORIGIN_SCHEMES.has(o.protocol)) return false;
  if (!o.host) return false;

  const allow = allowedOrigins();
  // Compare the full origin, so the SCHEME is part of the decision. Comparing
  // only `o.host` accepted an https Origin on an http-only host.
  if (allow.has(o.origin.toLowerCase())) return true;
  const allowHosts = new Set<string>();
  for (const entry of allow) {
    const n = normaliseHost(entry);
    if (n) allowHosts.add(n);
  }
  if (allowHosts.has(o.host.toLowerCase())) return true;
  const host = requestHost(request);
  if (!host) return false;
  // The Origin is https while the panel was addressed over http: that is a
  // protocol-confusion shape, not same-origin.
  //
  // A scheme mismatch is only a signal when BOTH sides are honestly known, and
  // `requestScheme` is honest about neither by default:
  //
  //   - The Next standalone server REBUILDS request.url from its own bind
  //     address (install.sh sets HOSTNAME=0.0.0.0), so it reports the internal
  //     hop -- always http, even when the browser connected over https.
  //   - Behind a TLS-terminating proxy that rewrites Host but omits
  //     X-Forwarded-Proto, the fallback is likewise the internal http hop.
  //
  // So comparing Origin-scheme against requestScheme rejected every browser
  // request on a panel served over https -- the exact "Cross-origin request
  // rejected on every action" failure this function exists to avoid. It passed
  // only for non-browser clients, which send no Origin and short-circuit above.
  //
  // The scheme check is therefore required only when the request actually
  // arrived over a scheme we were told about (X-Forwarded-Proto under an opt-in
  // trusted proxy, or a real https request.url). Otherwise the host match alone
  // decides. This does not weaken the boundary: an attacker cannot make the
  // check vacuous, because forging X-Forwarded-Proto requires XT_TRUST_PROXY,
  // and without that flag requestHost ignores X-Forwarded-Host too, so the host
  // being compared is the one the client genuinely addressed.
  const schemeIsKnown =
    process.env.XT_TRUST_PROXY === "true" && forwardedProtoIsPresent(request);
  if (schemeIsKnown && o.protocol !== requestScheme(request)) return false;
  return normaliseHost(o.host) === normaliseHost(host);
}

/**
 * Canonical form of a host[:port] for comparison.
 *
 * WHATWG URL drops the default port from `host` (http://x:80 -> "x") while the
 * Host header keeps it, so comparing the two verbatim rejects the panel's own
 * documented http://host:80 deployment. Normalise both sides through the same
 * rules, and refuse anything that is not a plain host[:port].
 */
function normaliseHost(host: string): string | null {
  const h = host.trim().toLowerCase();
  if (!h) return null;
  // Re-parse so the default port is dropped exactly as the URL parser would.
  try {
    return new URL(`http://${h}`).host.toLowerCase();
  } catch {
    return null;
  }
}
