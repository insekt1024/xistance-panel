"use client";

import * as React from "react";

/**
 * Keeps the session alive while the panel is open.
 *
 * The access token lives 15 minutes and the refresh token 30 days, but
 * nothing ever exchanged one for the other — so an open dashboard logged
 * itself out every 15 minutes even while actively polling. API calls now
 * renew on their own (requireSession falls back to refreshSession), but a tab
 * that only re-renders server components never issues one, so rotate on a
 * timer as well.
 *
 * Runs only while the tab is visible: a backgrounded tab does not need a
 * session, and refreshing one wakes the server for nothing.
 */
const REFRESH_INTERVAL_MS = 10 * 60_000; // comfortably inside the 15m access TTL

function csrfToken(): string {
  const m = /xt_csrf=([^;]+)/.exec(document.cookie);
  return m ? m[1] : "";
}

export function SessionKeepalive() {
  React.useEffect(() => {
    let cancelled = false;

    async function renew() {
      if (document.hidden || cancelled) return;
      try {
        await fetch("/api/auth/refresh", {
          method: "POST",
          headers: { "X-CSRF-Token": csrfToken() },
        });
      } catch {
        // Offline or the panel restarted; the next tick retries.
      }
    }

    const timer = setInterval(renew, REFRESH_INTERVAL_MS);
    // A tab that slept past the access TTL renews as soon as it comes back,
    // before the user's first click can 401.
    document.addEventListener("visibilitychange", renew);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", renew);
    };
  }, []);

  return null;
}
