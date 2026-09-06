"use client";

import { useEffect, useCallback } from "react";
import { useRouter } from "@/i18n/routing";

interface UseKeyboardShortcutsOptions {
  onOpenSearch?: () => void;
  onOpenHelp?: () => void;
  onCloseDialog?: () => void;
}

export function useKeyboardShortcuts({
  onOpenSearch,
  onOpenHelp,
  onCloseDialog,
}: UseKeyboardShortcutsOptions = {}) {
  const router = useRouter();

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      // ? for help (only when not in input)
      if (event.key === "?" && !isInput && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        onOpenHelp?.();
        return;
      }

      // Escape to close dialogs
      if (event.key === "Escape") {
        onCloseDialog?.();
        return;
      }

      // Ctrl/Cmd + K for search
      if ((event.ctrlKey || event.metaKey) && event.key === "k") {
        event.preventDefault();
        onOpenSearch?.();
        return;
      }

      // Ctrl/Cmd + N for new tunnel
      if ((event.ctrlKey || event.metaKey) && event.key === "n") {
        event.preventDefault();
        router.push("/tunnels/new");
        return;
      }
    },
    [router, onOpenSearch, onOpenHelp, onCloseDialog],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}
