"use client";

import * as React from "react";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import dynamic from "next/dynamic";

const KeyboardShortcutsHelp = dynamic(
  () => import("@/components/keyboard-shortcuts-help").then((m) => ({ default: m.KeyboardShortcutsHelp })),
  { ssr: false },
);

const SearchDialog = dynamic(
  () => import("@/components/search-dialog").then((m) => ({ default: m.SearchDialog })),
  { ssr: false },
);

export function KeyboardShortcutsProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);

  // Listen for custom open-search event from navbar button
  React.useEffect(() => {
    const handler = () => setSearchOpen(true);
    window.addEventListener("open-search", handler);
    return () => window.removeEventListener("open-search", handler);
  }, []);

  useKeyboardShortcuts({
    onOpenSearch: () => setSearchOpen(true),
    onOpenHelp: () => setHelpOpen(true),
    onCloseDialog: () => {
      if (searchOpen) setSearchOpen(false);
      else if (helpOpen) setHelpOpen(false);
    },
  });

  return (
    <>
      {children}
      {searchOpen && <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />}
      {helpOpen && <KeyboardShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />}
    </>
  );
}
