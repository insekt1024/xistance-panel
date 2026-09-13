import { APP_REPO_URL, APP_VERSION } from "@/lib/version";
import { isNewerVersion } from "@/lib/update";
import { apiError, json, requireSession } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";

const RELEASES_URL = `${APP_REPO_URL}/releases/latest`;
const API_URL = "https://api.github.com/repos/insekt1024/xistance-panel/releases/latest";
// Cache the GitHub answer in-process: the releases API is rate-limited for
// anonymous callers, and every settings visit must not cost a request.
const CACHE_TTL_MS = 60 * 60_000;
let cache: { at: number; tag: string | null } | null = null;

async function fetchLatestTag(): Promise<string | null> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.tag;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `xistance-panel/${APP_VERSION}`,
      },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!res.ok) {
      // Negative cache for 5 minutes so a GitHub outage doesn't serialize
      // every click into an 8s timeout.
      cache = { at: now - CACHE_TTL_MS + 5 * 60_000, tag: cache?.tag ?? null };
      return cache.tag;
    }
    const data = (await res.json()) as { tag_name?: string };
    cache = { at: now, tag: data.tag_name ?? null };
    return cache.tag;
  } catch {
    cache = { at: now - CACHE_TTL_MS + 5 * 60_000, tag: cache?.tag ?? null };
    return cache.tag;
  }
}

export async function GET(request: Request) {
  const auth = await requireSession(request);
  if (!auth.ok) return auth.response;
  const rl = rateLimit(`update-check:${auth.user.id}`, 10, 60_000);
  if (!rl.ok) return apiError("Too many check requests, slow down", 429);
  const latest = await fetchLatestTag();
  // Unknown (offline/GitHub down) is reported honestly: available=false with
  // latest=null, so the UI shows "couldn't check" instead of lying.
  return json({
    current: APP_VERSION,
    latest,
    available: latest ? isNewerVersion(latest, APP_VERSION) : false,
    url: RELEASES_URL,
  });
}
