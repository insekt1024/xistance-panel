import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { APP_VERSION, APP_REPO_URL } from "@/lib/version";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const user = await getSession();
  if (user) redirect("/");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <LoginForm />
      <footer className="animate-fade-in mt-8 pb-4 text-center text-xs text-muted-foreground">
        <a
          href={APP_REPO_URL}
          target="_blank"
          rel="noreferrer"
          // min-h/min-w give the standalone footer link a 24x24 target (WCAG 2.5.8).
          // It is NOT an inline link in a sentence, so the exception does not apply.
          className="inline-flex min-h-6 min-w-6 items-center justify-center gap-1.5 transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Xistance Panel v{APP_VERSION}
        </a>
      </footer>
    </main>
  );
}
