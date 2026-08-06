"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import {
  Activity,
  ArrowRightLeft,
  Gauge,
  LayoutDashboard,
  Network,
  Settings,
  Users,
  Wrench,
  LogOut,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Link, usePathname, useRouter } from "@/i18n/routing";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageSwitcher } from "@/components/language-switcher";
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
  { key: "users", href: "/users", icon: Users },
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
    <header className="sticky top-0 z-40 w-full border-b bg-background/80 backdrop-blur">
      <div className="flex h-14 items-center gap-2 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Activity className="h-4 w-4" />
          </span>
          <span className="hidden sm:inline">Xistance</span>
        </Link>

        <nav className="mx-4 hidden items-center gap-1 md:flex">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
                  active && "bg-muted text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {t(item.key)}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-1 rtl:ml-0 rtl:mr-auto">
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
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
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
