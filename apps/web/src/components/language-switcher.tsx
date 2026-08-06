"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Check, Languages } from "lucide-react";
import { locales, localeInfo } from "@xistance/i18n";
import { Link, usePathname, routing } from "@/i18n/routing";
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
              {locale === routing.defaultLocale ? (
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
