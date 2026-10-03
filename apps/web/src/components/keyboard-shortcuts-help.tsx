"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Keyboard } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface Shortcut {
  keys: string[];
  label: string;
}

interface KeyboardShortcutsHelpProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function KeyboardShortcutsHelp({
  open,
  onOpenChange,
}: KeyboardShortcutsHelpProps) {
  const t = useTranslations("shortcuts");

  // Opened by the "?" shortcut, so Radix has no trigger to restore focus to and
  // would send it to <body>. Remember the opener and hand focus back from
  // onCloseAutoFocus, which is the documented override and runs after Radix's
  // own restore instead of racing it.
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    returnFocusRef.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);

  const shortcuts: Shortcut[] = [
    { keys: ["?"], label: t("showHelp") },
    { keys: ["Ctrl", "K"], label: t("openSearch") },
    { keys: ["Ctrl", "N"], label: t("newTunnel") },
    { keys: ["Esc"], label: t("closeDialog") },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const target = returnFocusRef.current;
          returnFocusRef.current = null;
          if (target && document.contains(target)) target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-5 w-5" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          {shortcuts.map((shortcut) => (
            <div
              key={shortcut.label}
              className="flex items-center justify-between"
            >
              <span className="text-sm text-muted-foreground">
                {shortcut.label}
              </span>
              <div className="flex gap-1">
                {shortcut.keys.map((key) => (
                  <kbd
                    key={key}
                    className="inline-flex h-6 items-center rounded border bg-muted px-1.5 font-mono text-xs font-medium text-muted-foreground"
                  >
                    {key}
                  </kbd>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
