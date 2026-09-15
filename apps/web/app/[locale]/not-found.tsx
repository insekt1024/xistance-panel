import { getLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";

const STRINGS = {
  en: {
    title: "Page not found",
    body: "The page you are looking for does not exist.",
    home: "Back to dashboard",
  },
  fa: {
    title: "صفحه پیدا نشد",
    body: "صفحه‌ای که به دنبال آن هستید وجود ندارد.",
    home: "بازگشت به داشبورد",
  },
} as const;

/**
 * Next does NOT pass `params` to a not-found boundary (only `error.tsx` gets
 * props), so reading the locale from props threw on every 404 and turned it
 * into a 500 — favicons, mistyped URLs and bots all produced stack traces.
 * Take the locale from the next-intl request context instead, and fall back
 * to English if this renders outside one.
 */
export default async function NotFound() {
  let locale = "en";
  try {
    locale = await getLocale();
  } catch {
    // Rendered outside a next-intl request scope (e.g. the global 404).
  }
  const t = locale === "fa" ? STRINGS.fa : STRINGS.en;
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="rounded-lg border bg-card p-8 text-center shadow-sm">
        <h1 className="text-2xl font-bold">{t.title}</h1>
        <p className="mt-2 text-muted-foreground">{t.body}</p>
        <Link
          href="/"
          className="mt-4 inline-block text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {t.home}
        </Link>
      </div>
    </div>
  );
}
