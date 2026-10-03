"use client";

import * as React from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import {
  ArrowRightLeft,
  Bell,
  Gauge,
  LayoutDashboard,
  Network,
  ScrollText,
  Search,
  Settings,
  Users,
  Wrench,
  LogOut,
} from "lucide-react";
import { apiFetch } from "@/lib/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Link, usePathname, useRouter } from "@/i18n/routing";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ConnectionStatus } from "@/components/connection-status";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

const NAV_ITEMS = [
  { key: "dashboard", href: "/", icon: LayoutDashboard },
  { key: "tunnels", href: "/tunnels", icon: Network },
  { key: "nodes", href: "/nodes", icon: Gauge },
  { key: "portForward", href: "/port-forward", icon: ArrowRightLeft },
  { key: "tools", href: "/tools", icon: Wrench },
  { key: "audit", href: "/audit", icon: ScrollText },
  { key: "users", href: "/users", icon: Users, children: [{ key: "activity", href: "/users/activity" }] },
  { key: "webhooks", href: "/webhooks", icon: Bell },
  { key: "settings", href: "/settings", icon: Settings },
] as const;

interface NavbarProps {
  userName: string;
  userEmail: string;
}

export function Navbar({ userName, userEmail }: NavbarProps) {
  const t = useTranslations("nav");
  const tCommon = useTranslations("common");
  const pathname = usePathname();
  const router = useRouter();

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/80 shadow-[0_1px_8px_-4px_oklch(0_0_0/0.06)] backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="animate-fade-in flex h-14 items-center gap-2 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <Image
            src="/xistance-logo.svg"
            alt="Xistance Panel logo"
            className="h-7 w-7 rounded-md"
            width={28}
            height={28}
          />
          <span className="hidden sm:inline">Xistance</span>
        </Link>

        <nav className="mx-4 hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto md:flex">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const hasChildren = "children" in item && item.children.length > 0;
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            
            if (hasChildren) {
              return (
                <DropdownMenu key={item.key}>
                  <DropdownMenuTrigger asChild>
                    <button
                      className={cn(
                        "group relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all duration-200",
                        active
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:scale-110" />
                      {/* A nav label may take TWO lines in Persian ("ابزارهای تست",
                          "لاگ فعالیت‌ها"), but never three. `whitespace-nowrap`
                          would clip instead of wrap, and leaving it unconstrained
                          produced a 3-line label in a 12-13px column at 768px --
                          measured by test-dashboard-legibility.ts. */}
                      <span className="min-w-0 leading-tight">{t(item.key)}</span>
                      {active && (
                        <span className="absolute inset-x-3 -bottom-[7px] h-0.5 rounded-full bg-primary" />
                      )}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem asChild>
                      <Link href={item.href}>{t(item.key)}</Link>
                    </DropdownMenuItem>
                    {item.children.map((child) => (
                      <DropdownMenuItem key={child.key} asChild>
                        <Link href={child.href}>{t(child.key)}</Link>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            }

            return (
              <Link
                key={item.key}
                href={item.href}
                className={cn(
                  "group relative flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all duration-200",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon className={cn(
                  "h-4 w-4 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:scale-110",
                )} />
                {t(item.key)}
                {active && (
                  <span className="absolute inset-x-3 -bottom-[7px] h-0.5 rounded-full bg-primary" />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="ms-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 text-muted-foreground"
            onClick={() => window.dispatchEvent(new CustomEvent("open-search"))}
          >
            <Search className="h-4 w-4" />
            <span className="hidden lg:inline text-xs">{tCommon("search")}</span>
          </Button>
          <ConnectionStatus />
          <ThemeToggle />
          <LanguageSwitcher />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* The visible content is a single avatar initial. A screen reader
                  announces that as one meaningless character, so the trigger
                  needs the name it actually represents. Found by the smoke
                  suite: no logout path was reachable by an accessible name. */}
              <Button
                variant="ghost"
                size="icon"
                className="rounded-full"
                aria-label={t("accountMenu")}
                data-testid="account-menu-trigger"
              >
                <Avatar className="h-7 w-7" aria-hidden>
                  <AvatarFallback className="text-xs">
                    {userName.charAt(0).toUpperCase() || "U"}
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <p className="text-sm font-medium">{userName}</p>
                <p className="text-xs font-normal text-muted-foreground">
                  {userEmail}
                </p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/settings">{t("settings")}</Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={async () => {
                  // apiFetch, not raw fetch: /api/auth/logout runs csrfGuard, and
                  // a raw fetch sends no X-CSRF-Token, so the server answered 403
                  // and the user was navigated to /login while STILL SIGNED IN.
                  // The client looked like it worked; nothing had been revoked.
                  // Found by scripts/test-smoke-auth.ts, which asks the server
                  // whether the session survived rather than trusting the DOM.
                  const res = await apiFetch<{ ok?: boolean }>("/api/auth/logout", { method: "POST" });
                  if (!res.ok) {
                    // Surface the failure instead of pretending: staying signed
                    // in on a panel is worse than an error toast.
                    toast.error(t("logoutFailed"));
                    return;
                  }
                  router.replace("/login");
                  router.refresh();
                }}
              >
                <LogOut className="h-4 w-4" />
                {tCommon("logout")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Mobile nav */}
      <nav className="flex min-w-0 items-center gap-1 overflow-x-auto px-3 pb-2 md:hidden">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const hasChildren = "children" in item && item.children.length > 0;
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          
          if (hasChildren) {
            return (
              <React.Fragment key={item.key}>
                <Link
                  href={item.href}
                  className={cn(
                    "flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground",
                    active && "bg-muted text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {t(item.key)}
                </Link>
                {item.children.map((child) => {
                  const childActive = pathname.startsWith(child.href);
                  return (
                    <Link
                      key={child.key}
                      href={child.href}
                      className={cn(
                        "flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground",
                        childActive && "bg-muted text-foreground",
                      )}
                    >
                      {t(child.key)}
                    </Link>
                  );
                })}
              </React.Fragment>
            );
          }

          return (
            <Link
              key={item.key}
              href={item.href}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground",
                active && "bg-muted text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(item.key)}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
