import Link from "next/link";

import { getLocale, getTranslations } from "next-intl/server";

import { withLocale } from "@/lib/locale-routing";

import { AuthBadge } from "@/components/auth-badge";
import { MobileHeaderSettings } from "@/components/mobile-header-settings";
import { PetdexLogo } from "@/components/petdex-logo";

import { hasLocale, type Locale } from "@/i18n/config";

type SiteHeaderProps = {
  hideSubmitCta?: boolean;
};

type NavItem = {
  href: string;
  label: string;
  external?: boolean;
  ariaLabel?: string;
};

export async function SiteHeader({ hideSubmitCta = false }: SiteHeaderProps) {
  const locale = await getLocale();
  const currentLocale: Locale = hasLocale(locale) ? locale : "en";
  const t = await getTranslations("header");
  const common = await getTranslations("common");
  const href = (pathname: string) => withLocale(pathname, currentLocale);
  const primary: NavItem[] = [
    { href: href("/collections"), label: t("collections") },
    { href: href("/leaderboard"), label: t("creators") },
    { href: href("/requests"), label: t("requests") },
    { href: href("/download"), label: t("download") },
    { href: href("/docs"), label: t("docs") },
    { href: href("/advertise"), label: t("advertise") },
    { href: href("/create"), label: t("create") },
    { href: href("/built-with"), label: t("builtWith") },
    ...(process.env.NEXT_PUBLIC_DISCORD_INVITE_URL
      ? [{ href: href("/community"), label: t("community") }]
      : []),
    {
      href: "https://github.com/crafter-station/petdex",
      label: common("github"),
      external: true,
      ariaLabel: t("githubRepoAria"),
    },
  ];

  return (
    <header className="sticky top-0 z-40 w-full border-b border-foreground/[0.06] bg-background/88 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
      <nav className="mx-auto flex w-full max-w-[1440px] items-center justify-between gap-3 px-4 py-3 sm:px-5 md:px-8">
        <div className="flex min-w-0 items-center gap-4 lg:gap-7">
          <PetdexLogo
            href={href("/")}
            ariaLabel={common("petdexHome")}
            markClassName="size-8 sm:size-9"
            className="gap-2 sm:gap-3 [&>span]:hidden sm:[&>span]:inline sm:[&>span]:text-lg"
          />

          <div className="hidden items-center gap-0.5 xl:flex">
            {primary.map((item) => (
              <HeaderNavLink
                key={item.href}
                item={item}
                className="inline-flex h-9 items-center rounded-full px-2.5 text-sm font-medium text-muted-2 transition hover:bg-surface-muted hover:text-foreground"
              />
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {hideSubmitCta ? null : (
            <Link
              href={href("/submit")}
              prefetch={false}
              className="hidden h-10 items-center justify-center rounded-full bg-inverse px-4 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover md:inline-flex"
            >
              {t("submitCta")}
            </Link>
          )}
          <details className="group relative xl:hidden">
            <summary
              aria-label={t("openMenu")}
              className="grid size-10 cursor-pointer list-none place-items-center rounded-full border border-border-base bg-surface/70 text-muted-2 transition hover:bg-surface hover:text-foreground [&::-webkit-details-marker]:hidden"
            >
              <span className="flex flex-col gap-1.5" aria-hidden="true">
                <span className="h-0.5 w-4 rounded-full bg-current" />
                <span className="h-0.5 w-4 rounded-full bg-current" />
              </span>
            </summary>
            <div className="absolute top-12 right-0 z-50 w-[min(280px,calc(100vw-2rem))] rounded-2xl border border-border-base bg-surface p-2 shadow-xl shadow-blue-950/15">
              {primary.map((item) => (
                <HeaderNavLink
                  key={item.href}
                  item={item}
                  className="flex rounded-xl px-3 py-2.5 text-sm font-medium text-foreground transition hover:bg-surface-muted"
                />
              ))}
              {hideSubmitCta ? null : (
                <Link
                  href={href("/submit")}
                  prefetch={false}
                  className="mt-1 flex rounded-xl bg-inverse px-3 py-2.5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
                >
                  {t("submitCta")}
                </Link>
              )}
              <MobileHeaderSettings />
            </div>
          </details>
          <AuthBadge compact />
        </div>
      </nav>
    </header>
  );
}

function HeaderNavLink({
  item,
  className,
}: {
  item: NavItem;
  className: string;
}) {
  if (item.external) {
    return (
      <a
        href={item.href}
        target="_blank"
        rel="noreferrer"
        aria-label={item.ariaLabel}
        className={className}
      >
        {item.label}
      </a>
    );
  }

  return (
    <Link
      href={item.href}
      prefetch={false}
      aria-label={item.ariaLabel}
      className={className}
    >
      {item.label}
    </Link>
  );
}
