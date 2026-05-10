"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useUser } from "@clerk/nextjs";
import {
  BookOpenIcon,
  CrownIcon,
  DownloadSimpleIcon,
  HandHeartIcon,
  MegaphoneIcon,
  PaintBrushIcon,
  PuzzlePieceIcon,
  StackIcon,
  UploadSimpleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { ExternalLink, Menu, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { isAdminClientSafe } from "@/lib/admin";
import { withLocale } from "@/lib/locale-routing";
import { cn } from "@/lib/utils";

import { AuthBadge } from "@/components/auth-badge";
import { GithubStarsLink } from "@/components/github-stars-link";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { PetdexLogo } from "@/components/petdex-logo";
import { SubmitCTA } from "@/components/submit-cta";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";

import { hasLocale, type Locale } from "@/i18n/config";

type SiteHeaderProps = {
  hideSubmitCta?: boolean;
};

type NavItem = {
  href: string;
  title: string;
  description: string;
  icon: React.ComponentType<{
    className?: string;
    weight?: "regular" | "fill" | "duotone" | "bold";
  }>;
  external?: boolean;
  badge?: string;
};

export function SiteHeader({ hideSubmitCta = false }: SiteHeaderProps) {
  const [open, setOpen] = useState(false);
  const locale = useLocale();
  const currentLocale: Locale = hasLocale(locale) ? locale : "en";
  const t = useTranslations("header");
  const common = useTranslations("common");

  // /download is public now (post pre-launch).
  const { user } = useUser();
  void user;
  const showDownload = true;
  void isAdminClientSafe;

  function href(pathname: string) {
    return withLocale(pathname, currentLocale);
  }

  const browseItems: NavItem[] = [
    {
      href: href("/collections"),
      title: t("collections"),
      description: t("collectionsDesc"),
      icon: StackIcon,
    },
    {
      href: href("/leaderboard"),
      title: t("creators"),
      description: t("creatorsDesc"),
      icon: CrownIcon,
    },
    {
      href: href("/requests"),
      title: t("requests"),
      description: t("requestsDesc"),
      icon: HandHeartIcon,
    },
  ];

  const buildItems: NavItem[] = [
    ...(showDownload
      ? [
          {
            href: href("/download"),
            title: t("download"),
            description: t("downloadDesc"),
            icon: DownloadSimpleIcon,
            badge: "new",
          } as NavItem,
        ]
      : []),
    {
      href: href("/submit"),
      title: t("submitCta"),
      description: t("submitDesc"),
      icon: UploadSimpleIcon,
    },
    {
      href: href("/create"),
      title: t("create"),
      description: t("createDesc"),
      icon: PaintBrushIcon,
    },
    {
      href: href("/docs"),
      title: t("docs"),
      description: t("docsDesc"),
      icon: BookOpenIcon,
    },
  ];

  const earnItems: NavItem[] = [
    {
      href: href("/advertise"),
      title: t("advertise"),
      description: t("advertiseDesc"),
      icon: MegaphoneIcon,
    },
    {
      href: href("/built-with"),
      title: t("builtWith"),
      description: t("builtWithDesc"),
      icon: PuzzlePieceIcon,
      badge: "new",
    },
    ...(process.env.NEXT_PUBLIC_DISCORD_INVITE_URL
      ? [
          {
            href: href("/community"),
            title: t("community"),
            description: t("communityDesc"),
            icon: UsersThreeIcon,
          },
        ]
      : []),
  ];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const scrolled = useScrolled(64);

  return (
    <>
      <header
        data-scrolled={scrolled || undefined}
        className="sticky top-0 z-40 w-full border-b border-transparent transition-[border-color,background-color,backdrop-filter] duration-200 data-scrolled:border-foreground/[0.06] data-scrolled:bg-background/85 data-scrolled:backdrop-blur-md data-scrolled:supports-[backdrop-filter]:bg-background/65"
      >
        <nav
          className={cn(
            "mx-auto flex w-full max-w-[1440px] items-center justify-between gap-3 px-5 md:px-8",
            scrolled ? "py-2.5" : "py-4",
          )}
        >
          <div className="flex items-center gap-6">
            <PetdexLogo
              href={href("/")}
              ariaLabel={common("petdexHome")}
              markClassName={cn(
                "transition-[width,height] duration-200",
                scrolled ? "size-7" : "size-10",
              )}
              className={cn(
                "transition-[font-size,gap] duration-200",
                scrolled
                  ? "gap-2 [&>span]:text-base"
                  : "gap-3 [&>span]:text-xl",
              )}
            />

            <NavigationMenu className="hidden lg:flex">
              <NavigationMenuList className="gap-1">
                <NavigationMenuItem>
                  <NavigationMenuTrigger
                    className={cn(
                      "rounded-full bg-transparent text-muted-2 transition-[font-size,height] duration-200 hover:bg-surface-muted hover:text-foreground data-popup-open:bg-surface-muted data-popup-open:text-foreground",
                      scrolled ? "h-7 text-xs" : "h-9 text-sm",
                    )}
                  >
                    {t("discover")}
                  </NavigationMenuTrigger>
                  <NavigationMenuContent>
                    <NavGrid items={browseItems} />
                  </NavigationMenuContent>
                </NavigationMenuItem>

                <NavigationMenuItem>
                  <NavigationMenuTrigger
                    className={cn(
                      "relative rounded-full bg-transparent text-muted-2 transition-[font-size,height] duration-200 hover:bg-surface-muted hover:text-foreground data-popup-open:bg-surface-muted data-popup-open:text-foreground",
                      scrolled ? "h-7 text-xs" : "h-9 text-sm",
                    )}
                  >
                    {t("make")}
                    {buildItems.some((i) => i.badge === "new") ? (
                      <NewDot />
                    ) : null}
                  </NavigationMenuTrigger>
                  <NavigationMenuContent>
                    <NavGrid items={buildItems} />
                  </NavigationMenuContent>
                </NavigationMenuItem>

                <NavigationMenuItem>
                  <NavigationMenuTrigger
                    className={cn(
                      "relative rounded-full bg-transparent text-muted-2 transition-[font-size,height] duration-200 hover:bg-surface-muted hover:text-foreground data-popup-open:bg-surface-muted data-popup-open:text-foreground",
                      scrolled ? "h-7 text-xs" : "h-9 text-sm",
                    )}
                  >
                    {t("promote")}
                    {earnItems.some((i) => i.badge === "new") ? (
                      <NewDot />
                    ) : null}
                  </NavigationMenuTrigger>
                  <NavigationMenuContent>
                    <NavGrid items={earnItems} />
                  </NavigationMenuContent>
                </NavigationMenuItem>
              </NavigationMenuList>
            </NavigationMenu>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {hideSubmitCta ? null : (
              <SubmitCTA
                href={href("/submit")}
                className={cn(
                  buttonVariants({ variant: "petdex-cta" }),
                  "hidden items-center justify-center px-4 font-medium transition-[height,font-size] duration-200 md:inline-flex",
                  scrolled ? "h-9 text-xs" : "h-11 text-sm",
                )}
              >
                {t("submitCta")}
              </SubmitCTA>
            )}
            <GithubStarsLink
              className={cn(
                buttonVariants({ variant: "petdex-pill" }),
                "hidden items-center gap-1.5 px-3 transition-[height] duration-200 md:inline-flex",
                scrolled ? "h-9" : "h-11",
              )}
            />
            <Button
              type="button"
              variant="petdex-pill"
              aria-label={open ? t("closeMenu") : t("openMenu")}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className={cn(
                "p-0 transition-[width,height] duration-200 lg:hidden",
                scrolled ? "size-9" : "size-11",
              )}
            >
              {open ? <X className="size-4" /> : <Menu className="size-4" />}
            </Button>
            <AuthBadge compact={scrolled} />
          </div>
        </nav>
      </header>

      {open ? (
        <div className="fixed inset-0 z-40 flex flex-col bg-background/95 backdrop-blur lg:hidden">
          <button
            type="button"
            aria-label={t("closeMenu")}
            onClick={() => setOpen(false)}
            className="absolute inset-0"
          />
          <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
            <PetdexLogo href={href("/")} ariaLabel={common("petdexHome")} />
            <Button
              type="button"
              variant="petdex-pill"
              size="petdex-icon"
              aria-label={t("closeMenu")}
              onClick={() => setOpen(false)}
            >
              <X className="size-4" />
            </Button>
          </div>
          <nav className="mt-4 flex flex-col gap-1 px-5 text-lg">
            <MobileLink href={href("/create")} onClick={() => setOpen(false)}>
              {t("create")}
            </MobileLink>
            <MobileLink href={href("/docs")} onClick={() => setOpen(false)}>
              {t("docs")}
            </MobileLink>
            {showDownload ? (
              <MobileLink
                href={href("/download")}
                onClick={() => setOpen(false)}
              >
                <span className="inline-flex items-center gap-2">
                  {t("download")}
                  <span className="rounded-full bg-brand-tint px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.12em] text-brand uppercase ring-1 ring-brand/30 dark:bg-brand-tint-dark">
                    new
                  </span>
                </span>
              </MobileLink>
            ) : null}
            <MobileLink
              href={href("/collections")}
              onClick={() => setOpen(false)}
            >
              {t("collections")}
            </MobileLink>
            <MobileLink
              href={href("/leaderboard")}
              onClick={() => setOpen(false)}
            >
              {t("creators")}
            </MobileLink>
            <MobileLink href={href("/requests")} onClick={() => setOpen(false)}>
              {t("requests")}
            </MobileLink>
            <MobileLink
              href={href("/advertise")}
              onClick={() => setOpen(false)}
            >
              {t("advertise")}
            </MobileLink>
            {process.env.NEXT_PUBLIC_DISCORD_INVITE_URL ? (
              <MobileLink
                href={href("/community")}
                onClick={() => setOpen(false)}
              >
                <span className="inline-flex items-center gap-2">
                  {t("community")}
                  <span className="rounded-full bg-brand-tint px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.12em] text-brand uppercase ring-1 ring-brand/30 dark:bg-brand-tint-dark">
                    new
                  </span>
                </span>
              </MobileLink>
            ) : null}
            <MobileLink href={href("/about")} onClick={() => setOpen(false)}>
              {t("about")}
            </MobileLink>
            <a
              href="https://x.com/raillyhugo"
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              className="flex items-center justify-between gap-2 rounded-2xl px-4 py-3 text-foreground transition hover:bg-white dark:hover:bg-stone-800"
            >
              <span className="inline-flex items-center gap-2">
                <XLogo className="size-4 text-muted-3" />
                {t("followOnX")}
              </span>
              <ExternalLink className="size-4 text-muted-4" />
            </a>
            <GithubStarsLink
              size="mobile"
              className="rounded-2xl px-4 py-3 hover:bg-surface-muted"
            />
          </nav>
          <div className="mx-5 mt-5 rounded-2xl border border-border-base bg-surface/70 p-3">
            <p className="px-1 pb-2 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
              {t("settings")}
            </p>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <LocaleSwitcher />
            </div>
          </div>

          {!hideSubmitCta ? (
            <div className="mt-auto p-5">
              <SubmitCTA
                href={href("/submit")}
                className={cn(
                  buttonVariants({ variant: "petdex-cta" }),
                  "inline-flex h-12 w-full items-center justify-center px-6 text-base font-medium",
                )}
              >
                {t("submitCta")}
              </SubmitCTA>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function NewDot() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute top-1 right-1 grid size-1.5 place-items-center"
    >
      <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-70" />
      <span className="relative inline-flex size-full rounded-full bg-brand" />
    </span>
  );
}

function NavGrid({ items }: { items: NavItem[] }) {
  return (
    <ul className="grid w-[360px] auto-rows-min gap-1 p-2">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <li key={item.href}>
            <NavigationMenuLink
              render={<Link href={item.href} />}
              closeOnClick
              className="group/item flex items-center gap-3 rounded-2xl p-2 pr-4 transition hover:bg-surface-muted focus:bg-surface-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-tint text-brand ring-1 ring-brand/15 transition group-hover/item:bg-brand group-hover/item:text-on-inverse group-hover/item:ring-brand dark:bg-brand-tint-dark dark:ring-brand/25">
                <Icon weight="duotone" className="size-4" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {item.title}
                  {item.badge ? (
                    <span className="rounded-full bg-brand-tint px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.12em] text-brand uppercase ring-1 ring-brand/30 dark:bg-brand-tint-dark">
                      {item.badge}
                    </span>
                  ) : null}
                </div>
                <p className="truncate text-xs leading-relaxed text-muted-3">
                  {item.description}
                </p>
              </div>
            </NavigationMenuLink>
          </li>
        );
      })}
    </ul>
  );
}

function XLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="currentColor"
    >
      <path d="M18.244 2H21l-6.55 7.49L22 22h-6.93l-4.83-6.31L4.6 22H1.84l7.01-8.02L1 2h7.07l4.36 5.78L18.244 2zm-2.43 18h1.91L7.27 4H5.27l10.544 16z" />
    </svg>
  );
}

function MobileLink({
  href,
  children,
  onClick,
}: {
  href: string;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className="rounded-2xl px-4 py-3 text-foreground transition hover:bg-white dark:hover:bg-stone-800"
    >
      {children}
    </Link>
  );
}

function useScrolled(threshold: number): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let frame = 0;
    // Hysteresis: enter compact at threshold, leave at threshold/2.
    // Prevents oscillation when the header height change shifts scrollY
    // back across the boundary. Frame-throttled to one update per paint.
    const enter = threshold;
    const exit = Math.max(0, threshold / 2);
    const evaluate = () => {
      frame = 0;
      const y = window.scrollY;
      setScrolled((prev) => (prev ? y > exit : y > enter));
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(evaluate);
    };
    evaluate();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, [threshold]);
  return scrolled;
}
