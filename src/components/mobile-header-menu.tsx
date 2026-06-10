"use client";

import Link from "next/link";

import { ExternalLink, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { withLocale } from "@/lib/locale-routing";
import { cn } from "@/lib/utils";

import { GithubStarsLink } from "@/components/github-stars-link";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { PetdexLogo } from "@/components/petdex-logo";
import { SubmitCTA } from "@/components/submit-cta";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button, buttonVariants } from "@/components/ui/button";

import { hasLocale, type Locale } from "@/i18n/config";

type Props = {
  hideSubmitCta?: boolean;
  onClose: () => void;
};

export function MobileHeaderMenu({ hideSubmitCta = false, onClose }: Props) {
  const locale = useLocale();
  const currentLocale: Locale = hasLocale(locale) ? locale : "en";
  const t = useTranslations("header");
  const common = useTranslations("common");
  const showDownload = true;

  function href(pathname: string) {
    return withLocale(pathname, currentLocale);
  }

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background/95 backdrop-blur lg:hidden">
      <button
        type="button"
        aria-label={t("closeMenu")}
        onClick={onClose}
        className="absolute inset-0"
      />
      <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
        <PetdexLogo href={href("/")} ariaLabel={common("petdexHome")} />
        <Button
          type="button"
          variant="petdex-pill"
          size="petdex-icon"
          aria-label={t("closeMenu")}
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      <nav className="mt-4 flex flex-col gap-1 px-5 text-lg">
        <MobileLink href={href("/create")} onClick={onClose}>
          {t("create")}
        </MobileLink>
        <MobileLink href={href("/docs")} onClick={onClose}>
          {t("docs")}
        </MobileLink>
        {showDownload ? (
          <MobileLink href={href("/download")} onClick={onClose}>
            <span className="inline-flex items-center gap-2">
              {t("download")}
              <span className="rounded-full bg-brand-tint px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.12em] text-brand uppercase ring-1 ring-brand/30 dark:bg-brand-tint-dark">
                new
              </span>
            </span>
          </MobileLink>
        ) : null}
        <MobileLink href={href("/collections")} onClick={onClose}>
          {t("collections")}
        </MobileLink>
        <MobileLink href={href("/leaderboard")} onClick={onClose}>
          {t("creators")}
        </MobileLink>
        <MobileLink href={href("/requests")} onClick={onClose}>
          {t("requests")}
        </MobileLink>
        <MobileLink href={href("/advertise")} onClick={onClose}>
          {t("advertise")}
        </MobileLink>
        <MobileLink href={href("/built-with")} onClick={onClose}>
          <span className="inline-flex items-center gap-2">
            {t("builtWith")}
            <span className="rounded-full bg-brand-tint px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[0.12em] text-brand uppercase ring-1 ring-brand/30 dark:bg-brand-tint-dark">
              new
            </span>
          </span>
        </MobileLink>
        {process.env.NEXT_PUBLIC_DISCORD_INVITE_URL ? (
          <MobileLink href={href("/community")} onClick={onClose}>
            {t("community")}
          </MobileLink>
        ) : null}
        <MobileLink href={href("/about")} onClick={onClose}>
          {t("about")}
        </MobileLink>
        <a
          href="https://x.com/raillyhugo"
          target="_blank"
          rel="noopener noreferrer"
          onClick={onClose}
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
      prefetch={false}
      onClick={onClick}
      className="rounded-2xl px-4 py-3 text-foreground transition hover:bg-white dark:hover:bg-stone-800"
    >
      {children}
    </Link>
  );
}
