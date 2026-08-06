export const locales = ["en", "fa"] as const;
export type Locale = (typeof locales)[number];

export const defaultLocale: Locale = "en";

export interface LocaleInfo {
  dir: "ltr" | "rtl";
  /** CSS font variable family used for this locale */
  font: "geist" | "vazirmatn";
  label: string;
  /** native endonym used in the language switcher */
  endonym: string;
}

export const localeInfo: Record<Locale, LocaleInfo> = {
  en: { dir: "ltr", font: "geist", label: "English", endonym: "English" },
  fa: { dir: "rtl", font: "vazirmatn", label: "Persian", endonym: "فارسی" },
};

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export function resolveLocale(value: string | undefined): Locale {
  if (value && isLocale(value)) return value;
  return defaultLocale;
}
