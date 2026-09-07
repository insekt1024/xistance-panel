import net from "node:net";
import dns from "node:dns/promises";

// ---------------------------------------------------------------------------
// SSRF guard for the diagnostics tools endpoint: blocks literal private IPs,
// internal hostnames, and hostnames resolving to private IPs.
// ---------------------------------------------------------------------------

/** True for loopback / private / link-local / reserved IPs (v4 + v6). */
export function isPrivateIp(ip: string): boolean {
  if (net.isIP(ip) === 0) return false;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0
    );
  }
  const low = ip.toLowerCase();
  return (
    low === "::1" ||
    low === "::" ||
    low.startsWith("fe80:") ||
    low.startsWith("fc") ||
    low.startsWith("fd")
  );
}

const BLOCKED_SUFFIXES = [".internal", ".local", ".localhost", ".invalid"];
const BLOCKED_NAMES = new Set(["localhost", "metadata.google.internal"]);

/**
 * SSRF guard: blocks literal private IPs, internal names, and hostnames that
 * resolve to private IPs. Fail-closed on DNS errors. NOTE: does not defend
 * against DNS-rebinding TOCTOU between check and connect — probes are
 * rate-limited (20/min) to bound that residual risk.
 */
export async function isBlockedTarget(host: string): Promise<boolean> {
  if (net.isIP(host)) return isPrivateIp(host);
  const h = host.toLowerCase().replace(/\.+$/, "");
  if (BLOCKED_NAMES.has(h) || BLOCKED_SUFFIXES.some((s) => h.endsWith(s))) return true;
  try {
    const addrs = await dns.lookup(h, { all: true });
    return addrs.some((a) => isPrivateIp(a.address));
  } catch {
    return true;
  }
}
