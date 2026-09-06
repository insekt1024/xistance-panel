"use client";

import * as React from "react";
import { useRouter } from "@/i18n/routing";
import { usePathname } from "next/navigation";

/**
 * Periodically re-renders the surrounding server components (live tunnel
 * status, byte counters) while the tab is visible, without a full reload.
 */
export function AutoRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const last = React.useRef(pathname);

  React.useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      // Refresh if still on the same page (avoids refreshing a mid-navigation).
      if (last.current === pathname) router.refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs, pathname]);

  React.useEffect(() => {
    last.current = pathname;
  }, [pathname]);

  return null;
}