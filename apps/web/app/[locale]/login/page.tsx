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
          className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
        >
          Xistance Panel v{APP_VERSION}
        </a>
      </footer>
    </main>
  );
}
