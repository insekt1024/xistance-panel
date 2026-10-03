import net from "node:net";

import { ipv6Bytes } from "./ssrf";

/**
 * Policy check for the X-UI / 3X-UI panel probe (`/api/xui/test`).
 *
 * This route is a deliberate exception to the SSRF blocklist: a 3X-UI panel
 * usually lives on the user's own VPS, frequently at a private or tailnet
 * address, and blocking RFC1918 would break the feature outright. So
 * `isBlockedTarget` must NOT be applied here wholesale.
 *
 * But "private is allowed" is not "anything on the panel host is allowed". Two
 * classes remain unconditionally unreachable, and they are the ones that turn
 * this route into a server-side request forgery primitive rather than a
 * convenience:
 *
 *   - **loopback** (`127.0.0.0/8`, `::1`, and any IPv4-mapped form): the panel
 *     itself, its own admin port, and anything else bound only to localhost on
 *     that host. A USER calling this route must not be able to make the panel
 *     fetch its own authenticated admin surface.
 *   - **link-local** (`169.254.0.0/16`, `fe80::/10`): the cloud instance
 *     metadata service. `169.254.169.254` hands out instance credentials to
 *     anything that asks, so reaching it from a USER-supplied URL is a cloud
 *     account compromise, not a panel bug.
 *
 * Everything else — RFC1918, CGNAT, the RFC 5737 documentation ranges — stays
 * reachable, because that is what the feature is for.
 *
 * A hostname is NOT resolved here. Blocking on the name alone would either
 * over-block (a public name that resolves privately) or under-block, and the
 * honest statement of that residual risk is that the DNS-rebinding window
 * remains open on this route. It is the same bounded, documented residual the
 * tools route carries; closing it requires pinning the resolved address and
 * connecting to it, which is a larger change than a release should absorb
 * untested on a target host.
 *
 * Returns an error message to surface, or null when the target is acceptable.
 */
export function rejectPanelProbeHost(hostname: string): string | null {
  // Strip the brackets a URL keeps around an IPv6 literal.
  const bare = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  // An IPv4-mapped IPv6 literal (::ffff:127.0.0.1) is a loopback address to a
  // socket, so it must be judged as the v4 address it wraps.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(bare);
  if (mapped) {
    return rejectPanelProbeHost(mapped[1] as string);
  }

  const family = net.isIP(bare);
  if (family === 0) {
    // A name, not a literal. Nothing to judge here; see the note above.
    return null;
  }

  if (family === 4) {
    const parts = bare.split(".").map(Number);
    const a = parts[0] as number;
    const b = parts[1] as number;
    if (a === 127) return "A 3X-UI panel on the panel's own loopback address is not allowed";
    if (a === 169 && b === 254) {
      return "Link-local addresses are not allowed (this includes the cloud metadata service)";
    }
    if (a === 0) return "Unspecified addresses are not allowed";
    return null;
  }

  // IPv6: ::1 loopback, fe80::/10 link-local, :: unspecified. Reuse the
  // battle-tested expansion from ssrf.ts rather than a second parser: a naive
  // split(":") on "::1" yields two bytes and silently matches nothing, which
  // reads as "allowed" for the exact address that must be refused.
  const bytes = ipv6Bytes(bare);
  if (!bytes) return null;
  if (bytes.slice(0, 15).every((x) => x === 0) && bytes[15] === 1) {
    return "A 3X-UI panel on the panel's own loopback address is not allowed";
  }
  if ((bytes[0] as number) === 0xfe && ((bytes[1] as number) & 0xc0) === 0x80) {
    return "Link-local addresses are not allowed (this includes the cloud metadata service)";
  }
  if (bytes.every((x) => x === 0)) return "Unspecified addresses are not allowed";
  return null;
}
