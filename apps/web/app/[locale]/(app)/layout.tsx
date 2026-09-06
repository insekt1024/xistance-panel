import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { Navbar } from "@/components/navbar";
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
          className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
        >
          Xistance Panel v{APP_VERSION}
        </a>
      </footer>
    </div>
  );
}
