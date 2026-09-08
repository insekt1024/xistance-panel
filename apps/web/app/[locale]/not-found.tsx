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

export default async function NotFound({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
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
