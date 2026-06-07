"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

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
import { Menu, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { withLocale } from "@/lib/locale-routing";
import { cn } from "@/lib/utils";

import { AuthBadge } from "@/components/auth-badge";
import { GithubStarsLink } from "@/components/github-stars-link";
import { PetdexLogo } from "@/components/petdex-logo";
import { SubmitCTA } from "@/components/submit-cta";
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

const MobileHeaderMenu = dynamic(
  () =>
    import("@/components/mobile-header-menu").then(
      (mod) => mod.MobileHeaderMenu,
    ),
  { loading: () => <MobileHeaderMenuLoading />, ssr: false },
);

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
  const showDownload = true;

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

  const scrolled = useScrolled(64);
  const closeMenu = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [closeMenu, open]);

  return (
    <>
      <header
        data-scrolled={scrolled || undefined}
        className="sticky top-0 z-40 w-full border-b border-transparent transition-[border-color,background-color,backdrop-filter] duration-200 data-scrolled:border-foreground/[0.06] data-scrolled:bg-background/85 data-scrolled:backdrop-blur-md data-scrolled:supports-[backdrop-filter]:bg-background/65"
      >
        <nav
          className={cn(
            "mx-auto flex w-full max-w-[1440px] items-center justify-between gap-2 px-4 sm:gap-3 sm:px-5 md:px-8",
            scrolled ? "py-2.5" : "py-4",
          )}
        >
          <div className="flex min-w-0 items-center gap-4 lg:gap-6">
            <PetdexLogo
              href={href("/")}
              ariaLabel={common("petdexHome")}
              markClassName={cn(
                "transition-[width,height] duration-200",
                scrolled ? "size-7" : "size-8 sm:size-10",
              )}
              className={cn(
                "transition-[font-size,gap] duration-200",
                scrolled
                  ? "gap-2 [&>span]:text-base"
                  : "gap-2 [&>span]:hidden [&>span]:text-xl sm:[&>span]:inline sm:gap-3 sm:[&>span]:text-xl",
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

          <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
            {hideSubmitCta ? null : (
              <div className="hidden md:contents">
                <SubmitCTA
                  href={href("/submit")}
                  className={cn(
                    buttonVariants({ variant: "petdex-cta" }),
                    "inline-flex items-center justify-center px-4 font-medium transition-[height,font-size] duration-200",
                    scrolled ? "h-9 text-xs" : "h-11 text-sm",
                  )}
                >
                  {t("submitCta")}
                </SubmitCTA>
              </div>
            )}
            <div className="hidden lg:contents">
              <GithubStarsLink
                className={cn(
                  buttonVariants({ variant: "petdex-pill" }),
                  "inline-flex items-center gap-1.5 px-3 transition-[height] duration-200",
                  scrolled ? "h-9" : "h-11",
                )}
              />
            </div>
            <Button
              type="button"
              variant="petdex-pill"
              aria-label={open ? t("closeMenu") : t("openMenu")}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className={cn(
                "shrink-0 p-0 transition-[width,height] duration-200 lg:hidden",
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
        <MobileHeaderMenu hideSubmitCta={hideSubmitCta} onClose={closeMenu} />
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

function MobileHeaderMenuLoading() {
  return (
    <div
      aria-hidden
      className="fixed inset-0 z-30 bg-background/95 backdrop-blur lg:hidden"
    />
  );
}

function NavGrid({ items }: { items: NavItem[] }) {
  return (
    <ul className="grid w-[min(400px,calc(100vw-2rem))] auto-rows-min gap-1 p-2">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <li key={item.href}>
            <NavigationMenuLink
              render={<Link href={item.href} prefetch={false} />}
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
