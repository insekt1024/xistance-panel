import type { Metadata } from "next";
import { defineRouting } from "next-intl/routing";
import { createNavigation } from "next-intl/navigation";
import { locales, defaultLocale } from "@xistance/i18n";

export const routing = defineRouting({
  locales,
  defaultLocale,
  localePrefix: "as-needed",
});

export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing);

export type Locale = (typeof locales)[number];

// Re-export helpers so UI imports stay in one place.
export { defaultLocale };

export function buildMetadata(overrides: Metadata): Metadata {
  return { ...overrides };
}
