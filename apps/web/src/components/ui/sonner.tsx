"use client";

import { Toaster as Sonner } from "sonner";
import { useLocale } from "next-intl";

type ToasterProps = React.ComponentProps<typeof Sonner>;

export function Toaster(props: ToasterProps) {
  const locale = useLocale();
  return (
    <Sonner
      theme="system"
      dir={locale === "fa" ? "rtl" : "ltr"}
      position="top-center"
      richColors
      {...props}
    />
  );
}
