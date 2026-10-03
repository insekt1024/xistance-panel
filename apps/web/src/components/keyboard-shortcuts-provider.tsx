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

  // Both dialogs stay MOUNTED and are driven by `open`.
  //
  // Conditionally rendering them ({open && <Dialog .../>}) was the defect
  // scripts/test-dialog-keyboard.ts was written to catch: Radix restores focus
  // to the element that had it before the dialog opened, but unmounting the
  // dialog unmounts the app shell's trigger ref with it, so focus lands on
  // <body> and a keyboard user loses their place. Measured in a real browser:
  //   "returns focus to the trigger" -> focus fell back to <body>
  // Every other dialog in the app (nodes, tunnels, users, webhooks) was already
  // mounted this way; these two were the outliers.
  //
  // next/dynamic keeps the chunk out of the initial bundle, so holding it
  // mounted costs nothing until the shortcut is first used.
  return (
    <>
      {children}
      <SearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <KeyboardShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </>
  );
}
