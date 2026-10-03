import net from "node:net";
import dns from "node:dns/promises";

// ---------------------------------------------------------------------------
// SSRF guard for outbound probes: blocks loopback / private / link-local /
// reserved addresses (v4 and v6, including every IPv4-mapped and embedded form),
// internal hostnames, and hostnames that resolve to any of the above.
//
// BOUNDARY OF THIS DEFENCE -- read before relying on it:
//
//   1. It validates the ADDRESS, then lets the runtime resolve and connect. A
//      DNS answer can differ between the check and the connect (DNS rebinding),
//      so a hostile resolver could pass the check with a public address and
//      return a private one a moment later. Closing that window needs a pinned
//      resolution plus a connect-time re-check (a custom `lookup` that validates
//      every address it is about to hand back), which is the correct fix but
//      changes how every probe dials. The routes using this guard are
//      admin-only, per-user rate-limited and short-timeout, which bounds -- but
//      does not remove -- the residual risk.
//
//   2. It is fail-CLOSED: a name that does not resolve, or a bare label with no
//      dot, is treated as blocked rather than permitted.
//
//   3. It inspects the destination only. A public host that itself proxies
//      inward is out of scope; `redirect: "manual"` on the HTTP probes covers
//      the redirect half of that.
// ---------------------------------------------------------------------------

/** Strip the brackets WHATWG URL puts around an IPv6 host, e.g. `[::1]`. */
function unbracket(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** The bracket strip, exported for direct test. See test-ssrf-guard.ts. */
export const unbracketForTest = unbracket;

/**
 * Expand any legal IPv6 spelling to its 16 bytes.
 *
 * `::` compression, a trailing dotted-quad and uppercase hex are all handled by
 * writing to a byte array, because the same address can be spelled
 * `::ffff:127.0.0.1`, `0:0:0:0:0:ffff:7f00:1` or `::FFFF:7F00:1` -- three
 * different strings, one address, and a string comparison would treat them as
 * three separate hosts.
 */
/** Expand an IPv6 literal to its 16 bytes. Handles `::` compression and a
 *  trailing dotted-quad. Exported because the X-UI panel-probe policy needs to
 *  judge `::1` and `fe80::/10` correctly, and a second, subtly different IPv6
 *  parser is how `::1` silently becomes a 2-byte array that matches nothing. */
export function ipv6Bytes(ip: string): Uint8Array | null {
  const out = new Uint8Array(16);
  let head = ip;

  const lastColon = ip.lastIndexOf(":");
  if (ip.includes(".")) {
    // Trailing dotted-quad: rewrite it as two hextets first.
    const v4 = ip.slice(lastColon + 1);
    const parts = v4.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    // toString(16) is essential: the decimal form of 0x0a00 is "2560", and
    // parseInt("2560", 16) is 0x2560 -- a different address entirely.
    head = `${ip.slice(0, lastColon + 1)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }

  let groups: string[];
  if (head.includes("::")) {
    const [left, right] = head.split("::");
    const l = left ? left.split(":").filter(Boolean) : [];
    const r = right ? right.split(":").filter(Boolean) : [];
    const fill = 8 - l.length - r.length;
    if (fill < 0) return null;
    groups = [...l, ...Array<string>(fill).fill("0"), ...r];
  } else {
    groups = head.split(":").filter(Boolean);
  }
  if (groups.length !== 8) return null;

  for (let i = 0; i < 8; i++) {
    if (groups[i] === "" || !/^[0-9a-f]{1,4}$/i.test(groups[i])) return null;
    const v = parseInt(groups[i], 16);
    out[i * 2] = (v >> 8) & 0xff;
    out[i * 2 + 1] = v & 0xff;
  }
  return out;
}

/**
 * Extract the IPv4 address a v6 address merely wraps, or null.
 *
 * A socket treats `::ffff:127.0.0.1` as a connection to 127.0.0.1, so the
 * classification has to be too -- and it has to hold for every form that wraps
 * one: v4-mapped, deprecated v4-compatible, 6to4, and NAT64.
 */
function embeddedIpv4(b: Uint8Array): string | null {
  const v4 = `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  // ::ffff:a.b.c.d -- bytes 0..9 are zero and bytes 10..11 are the ffff marker.
  // (Testing bytes 0..11 for zero is wrong: it excludes every mapped address.)
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return v4;
  // ::a.b.c.d (deprecated v4-compatible) -- bytes 0..11 zero, and not :: or ::1.
  if (b.slice(0, 12).every((x) => x === 0) && !(b[12] === 0 && b[13] === 0 && b[14] === 0 && b[15] === 0)) {
    return v4;
  }
  // 6to4 2002::/16 -- the next 32 bits are the v4 address.
  if (b[0] === 0x20 && b[1] === 0x02) return `${b[2]}.${b[3]}.${b[4]}.${b[5]}`;
  // NAT64 well-known prefix 64:ff9b::/96.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
    return `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
  }
  return null;
}

/** True for loopback / private / link-local / CGNAT / reserved / multicast / broadcast. */
export function isPrivateIp(ipRaw: string): boolean {
  const ip = unbracket(ipRaw.trim());
  const family = net.isIP(ip);
  if (family === 0) return false;

  if (family === 4) {
    const parts = ip.split(".").map(Number);
    const a = parts[0];
    const b = parts[1];
    if (a === undefined || b === undefined) return false;
    if (a === 0) return true; // "this host", 0.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC 1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
    if (a === 192 && b === 168) return true; // RFC 1918
    if (a === 169 && b === 254) return true; // link-local: cloud metadata lives here
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT / shared address space
    if (a === 192 && b === 0) return true; // IETF protocol assignments, incl. TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51) return true; // TEST-NET-2
    if (a === 203 && b === 0) return true; // TEST-NET-3
    if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast 255.255.255.255
    return false;
  }

  const b = ipv6Bytes(ip);
  if (!b) return true; // an IPv6 literal we cannot parse is not something to dial

  // If the address merely WRAPS a v4 address, judge it by that v4 address.
  const inner = embeddedIpv4(b);
  if (inner) return isPrivateIp(inner);

  if (b.every((x) => x === 0)) return true; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // ::1
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xff) return true; // ff00::/8 multicast
  // 2001::/23 is the IETF special-purpose block: 2001::/32 Teredo, 2001:2::/48
  // benchmarking, 2001:db8::/32 documentation, 2001:10::/28 ORCHID. None of it
  // is a legitimate probe destination.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] <= 0x02) return true; // 2001::/23 (Teredo, benchmarking)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x0f) return true; // 2001:10::/28 ORCHID
  if (b[0] === 0x01 && b[1] === 0x00 && b.slice(2, 8).every((x) => x === 0)) return true; // 100::/64
  if (b[0] === 0x3f && b[1] === 0xfe) return true; // 3ffe::/16, retired
  return false;
}

const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost", ".invalid", ".home.arpa"];
const BLOCKED_NAMES = new Set(["localhost", "metadata.google.internal", "metadata.goog", "instance-data"]);

/**
 * Reject a value that a subprocess would read as an OPTION rather than an
 * operand. `ping -c 4 -W 3 -f127.0.0.1` turns the caller's "host" into a flag.
 */
export function looksLikeFlag(value: string): boolean {
  return value.startsWith("-");
}

/**
 * True for a name that cannot be a legitimate public probe target.
 *
 * A bare label with no dot is an intranet name in every common resolver, and a
 * bracketed literal that reached here is not a name at all. Both fail closed
 * without consulting DNS, so neither depends on what the resolver returns.
 */
export function isUnresolvableName(hostRaw: string): boolean {
  // Test the bracket on the RAW value: unbracket() runs first, so by the time
  // `h` exists the brackets are gone and `startsWith("[")` could never fire.
  if (hostRaw.startsWith("[")) return true;
  const h = unbracket(hostRaw).toLowerCase().replace(/\.+$/, "");
  if (h.length === 0) return true;
  if (!h.includes(".")) return true;
  return false;
}

/**
 * SSRF guard: blocks literal private/reserved IPs, internal names, and names
 * that resolve to private/reserved IPs. Fail-closed on DNS errors.
 */
export async function isBlockedTarget(hostRaw: string): Promise<boolean> {
  const host = unbracket(hostRaw.trim());
  if (looksLikeFlag(host)) return true;
  if (net.isIP(host) > 0) return isPrivateIp(host);

  const h = host.toLowerCase().replace(/\.+$/, "");
  if (h.length === 0) return true;
  if (BLOCKED_NAMES.has(h) || BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (isUnresolvableName(host)) return true;
  try {
    const addrs = await dns.lookup(h, { all: true });
    if (addrs.length === 0) return true;
    return addrs.some((a) => isPrivateIp(a.address));
  } catch {
    return true;
  }
}

/**
 * A short, log-safe description of a target: never the full address, so a probe
 * failure cannot echo a routable internal target into logs or the UI.
 */
export function describeAddress(hostRaw: string): string {
  const h = unbracket(hostRaw.trim()).toLowerCase();
  if (net.isIP(h) > 0) return isPrivateIp(h) ? "a private/reserved address" : "a public address";
  if (h.length === 0) return "an empty target";
  if (!h.includes(".")) return "a bare hostname";
  return h.length > 24 ? `${h.slice(0, 21)}...` : h;
}
