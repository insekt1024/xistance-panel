// Relative, not the "@/lib/ssrf" alias: scripts/ is outside apps/web, so the
// alias does not resolve under the tsx test runner (no tsconfig paths mapping
// applies from the repo root). The alias IS correct in the route files, which
// are compiled by Next inside apps/web.
import { isBlockedTarget, looksLikeFlag } from "./ssrf";

/**
 * A port-forward `destHost` is not inert data. At deploy time it becomes:
 *
 *   - a live `net.connect({ host, port })` on the tunnel node
 *     (`packages/tunnel-core/src/forwarder.ts:63`, `forwarder-runner.ts:55`), or
 *   - an argv element of `gost -L proto://:sourcePort/destHost:destPort`
 *     (`engine.ts:1355`).
 *
 * So an unvalidated `destHost` lets any authenticated user point a node at the
 * node's own loopback, its private network, or a cloud metadata endpoint, and
 * then read the reply through a forward they control. That is the same class the
 * tools API already blocks with `isBlockedTarget` (`app/api/tools/route.ts:73`).
 *
 * Reject at the API boundary so a hostile rule is never persisted, in either
 * direction: a rule created before this guard existed, or edited around it, is
 * the same exposure.
 *
 * Returns an error message to surface, or null when the host is acceptable.
 */
export async function rejectForwardHost(host: string): Promise<string | null> {
  // A host that starts with "-" is argv injection, not a hostname: gost would
  // read it as an option, and a shell-based forwarder would read it as a flag.
  if (looksLikeFlag(host)) return "Destination host may not look like a command-line flag";
  // Blocks loopback, RFC1918, link-local (incl. 169.254.169.254 metadata),
  // CGNAT, the RFC 5737 documentation ranges, multicast, and the internal /
  // local suffixes — and resolves a hostname before judging it.
  if (await isBlockedTarget(host)) {
    return "Forwarding to internal, private, or link-local addresses is not allowed";
  }
  return null;
}
