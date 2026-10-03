import type { DirectConfig } from "@xistance/types";

// ---------------------------------------------------------------------------
// DIRECT tunnel — single-node forward, zero peer coupling.
// Runs: gost -L <proto>://<bindAddr>:<listenPort>/<targetHost>:<targetPort>
// No outbound dial, no token, minimal RAM (~5MB). Pick the node closest to
// the target service (usually the Foreign node).
// ---------------------------------------------------------------------------

/**
 * A hostname or IPv4 literal, as it may appear inside a gost URL.
 *
 * Deliberately narrower than a general hostname: it excludes `/`, `?`, `#`,
 * `@`, whitespace, control characters and any scheme separator, because each of
 * those silently corrupts the URL rather than failing loudly. `a/b` became a
 * path, `a?b` started a query, and a full `tcp://host` doubled the scheme --
 * none raised an error, so the operator got a tunnel that quietly forwarded
 * somewhere else.
 */
const DIRECT_HOSTNAME =
  /^[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?)*$/;
const IPV6_LITERAL = /^[0-9A-Fa-f:.]+(?:%[A-Za-z0-9._~-]+)?$/;

function isIpv6Literal(host: string): boolean {
  // A colon is the discriminator: no hostname or IPv4 literal contains one.
  if (!host.includes(":")) return false;
  if (host.startsWith("[") && host.endsWith("]")) return false; // already bracketed
  return IPV6_LITERAL.test(host);
}

/** Validate a DIRECT bind address or target host, or throw. */
export function assertSafeDirectAddress(value: string, field: "bindAddr" | "targetHost"): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Invalid DIRECT ${field}: it must not be empty`);
  }
  if (value !== value.trim()) {
    throw new Error(`Invalid DIRECT ${field}: leading or trailing whitespace is not allowed`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid DIRECT ${field}: whitespace and control characters are not allowed`);
  }
  // Scheme FIRST. A value like "tcp://1.2.3.4" contains "//", so the delimiter
  // check would otherwise fire first and tell the operator that a "/" is
  // invalid -- true but useless, because what they actually did was paste a URL
  // where a bare address belongs.
  if (value.includes("://")) {
    throw new Error(`Invalid DIRECT ${field}: do not include a scheme, pass the bare address`);
  }
  if (/[/\\?#@]/.test(value)) {
    throw new Error(
      `Invalid DIRECT ${field}: ${JSON.stringify(value)} contains a URL delimiter ` +
        `(/ \\ ? # @), which would corrupt the tunnel URL`,
    );
  }
  if (value.startsWith("-")) {
    throw new Error(`Invalid DIRECT ${field}: a value starting with '-' would be parsed as an option`);
  }
  if (isIpv6Literal(value)) return;
  if (DIRECT_HOSTNAME.test(value)) return;
  throw new Error(
    `Invalid DIRECT ${field}: ${JSON.stringify(value)} is not a hostname, IPv4 or IPv6 literal`,
  );
}

/** Wrap an IPv6 literal in brackets, per RFC 3986. Idempotent. */
function authorityHost(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host;
  return isIpv6Literal(host) ? `[${host}]` : host;
}

export function buildDirectCommand(cfg: DirectConfig): string[] {
  assertSafeDirectAddress(cfg.bindAddr, "bindAddr");
  assertSafeDirectAddress(cfg.targetHost, "targetHost");

  // 0.0.0.0 and :: are the "all interfaces" shorthands and are emitted as an
  // empty authority, so the URL reads tcp://:PORT/... , which is what gost
  // expects.
  const wildcard = cfg.bindAddr === "0.0.0.0" || cfg.bindAddr === "::";
  const bind = wildcard ? "" : authorityHost(cfg.bindAddr);
  const listen = bind ? `${bind}:${cfg.listenPort}` : `:${cfg.listenPort}`;
  const target = authorityHost(cfg.targetHost);
  return ["gost", "-L", `${cfg.protocol}://${listen}/${target}:${cfg.targetPort}`];
}

export const DIRECT_BINARY = "gost";
