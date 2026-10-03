import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { Navbar } from "@/components/navbar";
import { SessionKeepalive } from "@/components/session-keepalive";
import { APP_VERSION, APP_REPO_URL } from "@/lib/version";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSession();
  if (!user) redirect("/login");

  return (
    <div className="flex min-h-screen flex-col">
      <SessionKeepalive />
      <Navbar userName={user.name} userEmail={user.email} />
      <main
        key="page-content"
        className="animate-fade-in mx-auto w-full max-w-7xl flex-1 px-4 py-6"
      >
        {children}
      </main>
      <footer className="border-t py-4 text-center text-xs text-muted-foreground">
        <a
          href={APP_REPO_URL}
          target="_blank"
          rel="noreferrer"
          // min-h/min-w give the standalone footer link a 24x24 target (WCAG 2.5.8).
          // It is NOT an inline link in a sentence, so the exception does not apply.
          className="inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Xistance Panel v{APP_VERSION}
        </a>
      </footer>
    </div>
  );
}
