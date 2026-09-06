"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  Activity,
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
  const pathname = usePathname();
  const router = useRouter();

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/80 shadow-[0_1px_8px_-4px_oklch(0_0_0/0.06)] backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="animate-fade-in flex h-14 items-center gap-2 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Activity className="h-4 w-4" />
          </span>
          <span className="hidden sm:inline">Xistance</span>
        </Link>

        <nav className="mx-4 hidden items-center gap-1 md:flex">
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
                      <Icon className="h-4 w-4 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:scale-110" />
                      {t(item.key)}
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

        <div className="ml-auto flex items-center gap-1 rtl:ml-0 rtl:mr-auto">
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 text-muted-foreground"
            onClick={() => window.dispatchEvent(new CustomEvent("open-search"))}
          >
            <Search className="h-4 w-4" />
            <span className="hidden lg:inline text-xs">{t("search", { ns: "common" })}</span>
          </Button>
          <ConnectionStatus />
          <ThemeToggle />
          <LanguageSwitcher />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="rounded-full">
                <Avatar className="h-7 w-7">
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
                  await fetch("/api/auth/logout", { method: "POST" });
                  router.replace("/login");
                }}
              >
                <LogOut className="h-4 w-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Mobile nav */}
      <nav className="flex items-center gap-1 overflow-x-auto px-3 pb-2 md:hidden">
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
