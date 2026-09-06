"use client";

import * as React from "react";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { KeyboardShortcutsHelp } from "@/components/keyboard-shortcuts-help";
import { SearchDialog } from "@/components/search-dialog";

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
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <KeyboardShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </>
  );
}
