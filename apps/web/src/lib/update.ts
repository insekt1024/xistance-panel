// ---------------------------------------------------------------------------
// Update check helpers: compare the running panel version against the latest
// GitHub release tag. Pure functions (unit-tested); the HTTP fetch + cache
// live in app/api/update/check/route.ts.
// ---------------------------------------------------------------------------

/** Parse "v1.2.3" / "1.2.3" (extra suffixes ignored) into a numeric triple. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True when `latest` is strictly newer than `current`. Unparseable tags
 *  never report an update (fail closed — no phantom "update available"). */
export function isNewerVersion(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (l[i] !== c[i]) return l[i] > c[i];
  }
  return false;
}
