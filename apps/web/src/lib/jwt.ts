import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Minimal HS256 JWT (no third-party deps). Used for short-lived access tokens
// only; refresh tokens are opaque random strings hashed in the DB.
// ---------------------------------------------------------------------------

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  jti: string;
  iat: number;
  exp: number;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function sign(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

export function signJwt(
  payload: Omit<JwtPayload, "iat" | "exp">,
  secret: string,
  expiresInSec: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const body: JwtPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSec,
  };
  const h = b64url(JSON.stringify(header));
  const b = b64url(JSON.stringify(body));
  const sig = sign(`${h}.${b}`, secret);
  return `${h}.${b}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  const expected = sign(`${h}.${b}`, secret);
  if (s.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(Buffer.from(b, "base64url").toString()) as JwtPayload;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
