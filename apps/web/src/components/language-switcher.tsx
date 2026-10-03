"use client";

import { useLocale, useTranslations } from "next-intl";
import { Check, Languages } from "lucide-react";
import { locales, localeInfo } from "@xistance/i18n";
import { Link, usePathname } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function LanguageSwitcher() {
  const t = useTranslations("settings");
  const pathname = usePathname();
  // The ACTIVE locale, not the default one. Marking `routing.defaultLocale`
  // instead meant an English user saw the tick on English (correct) and a
  // Persian user ALSO saw the tick on English, so the menu never showed which
  // language they were actually reading.
  const active = useLocale();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("language")}>
          <Languages className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {locales.map((locale) => (
          <DropdownMenuItem key={locale} asChild>
            <Link href={pathname} locale={locale}>
              <span className="flex-1">{localeInfo[locale].endonym}</span>
              {locale === active ? (
                <Check className="h-3.5 w-3.5 opacity-70" />
              ) : (
                <span className="sr-only">—</span>
              )}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
