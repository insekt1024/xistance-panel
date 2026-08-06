import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";
import en from "@xistance/i18n/messages/en.json";
import fa from "@xistance/i18n/messages/fa.json";

const messagesByLocale = { en, fa } as const;

export default getRequestConfig(async ({ requestLocale }) => {
  let locale = await requestLocale;
  if (!locale || !routing.locales.includes(locale as (typeof routing.locales)[number])) {
    locale = routing.defaultLocale;
  }
  return {
    locale,
    messages: messagesByLocale[locale as keyof typeof messagesByLocale],
    timeZone: "UTC",
    now: new Date(),
  };
});
