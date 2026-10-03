import type { Metadata } from "next";
import { defineRouting } from "next-intl/routing";
import { createNavigation } from "next-intl/navigation";
import { locales, defaultLocale } from "@xistance/i18n";

export const routing = defineRouting({
  locales,
  defaultLocale,
  // "as-needed" is NOT usable here. With the [locale] segment layout it makes
  // the proxy rewrite /login -> /en/login while also answering with
  // `Location: /login`, so the browser is sent back to the URL it came from and
  // the default locale loops forever. `/fa/login` worked, which hid the fault
  // behind the non-default locale.
  // "always" gives every locale a distinct, stable URL.
  localePrefix: "always",
});

export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);

export type Locale = (typeof locales)[number];

// Re-export helpers so UI imports stay in one place.
export { defaultLocale };

export function buildMetadata(overrides: Metadata): Metadata {
  return { ...overrides };
}
