/**
 * Asset-reference helpers shared by the artifact smoke suites.
 *
 * These live here rather than in one suite because two suites need them and
 * duplicating a regex is how the two copies drift. `collectAssetReferences` in
 * particular encodes a decision — "local, root-relative, not an API route" — and
 * a second, slightly different copy would quietly change which assets a smoke
 * test claims to have covered.
 *
 * Nothing here touches the network or the filesystem; the suites that import it
 * own their own server lifecycle and database.
 */

import type http from "node:http";

/**
 * Every local asset URL the given HTML references.
 *
 * Deliberately root-relative and local only: an absolute host would leave the
 * artifact, a `data:` URI is inline by definition, and an `/api/` path is a
 * request rather than a build output. `srcset` and `<source>` are included
 * because a font or responsive image referenced only there is still an asset
 * the release must ship, and a crawler that misses it reports a false pass.
 */
export function collectAssetReferences(html: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /<script[^>]+src="([^"]+)"/g,
    /<link[^>]+href="([^"]+)"/g,
    /<img[^>]+src="([^"]+)"/g,
    /<source[^>]+srcset="([^"]+)"/g,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const value = match[1];
      if (!value.startsWith("/") || value.startsWith("//")) continue;
      if (value.startsWith("/api/")) continue;
      found.add(value);
    }
  }
  return [...found];
}

/**
 * Whether a served asset's content type suits its extension.
 *
 * The extension decides the expectation. Matching on a directory instead — say,
 * treating everything under `/chunks/` as JavaScript — would classify the `.css`
 * files that live in the same directory as scripts and pass a build that serves
 * CSS with the wrong type. An unrecognised extension is accepted: this asserts
 * the types that are known to be mis-served, it is not a full MIME registry.
 */
export function mimeOk(headers: http.IncomingHttpHeaders, url: string): boolean {
  const type = String(headers["content-type"] ?? "");
  if (!type) return false;
  if (/\.(m?js)$/.test(url)) return /javascript|ecmascript/i.test(type);
  if (url.endsWith(".css")) return /text\/css/i.test(type);
  if (/\.(woff2?|ttf|otf|eot)$/.test(url)) return /font|octet-stream/i.test(type);
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico)$/.test(url)) return /image|svg|octet-stream/i.test(type);
  return true;
}

/**
 * URLs a release artifact must never serve.
 *
 * A build that accidentally stages the development tree passes every "does the
 * asset load" check while still shipping source maps, the test fixtures and
 * the source tree itself. Those are not build outputs, and a released artifact
 * containing them is a disclosure problem rather than a packaging nit — so the
 * paths are rejected by name instead of merely not being requested.
 */
export const FORBIDDEN_IN_ARTIFACT = [
  { pattern: /^\/_next\/static\/.*\.map($|\?)/, why: "a source map exposes the original source" },
  { pattern: /^\/__tests__\//, why: "a test file is not a build output" },
  { pattern: /^\/src\//, why: "the development source tree is not a build output" },
  { pattern: /^\/\.next\/server\//, why: "server internals are not a public asset" },
  { pattern: /^\/node_modules\//, why: "a dependency is not a public asset" },
  { pattern: /^\/\.env/, why: "a dotfile must never be served" },
] as const;

/** The reason a URL is forbidden, or null when it is acceptable. */
export function forbiddenReason(url: string): string | null {
  for (const { pattern, why } of FORBIDDEN_IN_ARTIFACT) {
    if (pattern.test(url)) return why;
  }
  return null;
}
