import { getLocale, getTranslations } from "next-intl/server";

import { withLocale } from "@/lib/locale-routing";
import { isStickerExplorerEnabled } from "@/lib/sticker-export-policy";

import { AuthBadge } from "@/components/auth/auth-badge";
import { LocaleSwitcher } from "@/components/brand/locale-switcher";
import { PetdexLogo } from "@/components/brand/petdex-logo";
import { ThemeToggle } from "@/components/brand/theme-toggle";
import { DesktopNav } from "@/components/site-header/desktop-nav";
import { GithubLink } from "@/components/site-header/github-link";
import { MobileNav } from "@/components/site-header/mobile-nav";
import { buildHeaderNav } from "@/components/site-header/nav-items";
import { SubmitLink } from "@/components/site-header/submit-link";
import type { SiteHeaderProps } from "@/components/site-header/types";

import { hasLocale, type Locale } from "@/i18n/config";

export async function SiteHeader({ hideSubmitCta = false }: SiteHeaderProps) {
  const locale = await getLocale();
  const currentLocale: Locale = hasLocale(locale) ? locale : "en";
  const t = await getTranslations("header");
  const common = await getTranslations("common");
  const href = (pathname: string) => withLocale(pathname, currentLocale);
  const nav = buildHeaderNav(
    href,
    {
      collections: t("collections"),
      reactions: t("reactions"),
      creators: t("creators"),
      requests: t("requests"),
      download: t("download"),
      docs: t("docs"),
      create: t("create"),
      builtWith: t("builtWith"),
      community: t("community"),
      github: common("github"),
      githubRepoAria: t("githubRepoAria"),
    },
    isStickerExplorerEnabled() || process.env.STICKER_EXPLORER_DEMO === "1",
  );

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
          <DesktopNav
            primary={nav.primary}
            secondary={nav.secondary}
            moreLabel={t("more")}
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <div className="hidden items-center gap-2 xl:flex">
            <ThemeToggle />
            <LocaleSwitcher />
          </div>
          <span
            aria-hidden="true"
            className="mx-1 hidden h-5 w-px bg-border-base xl:block"
          />
          <GithubLink item={nav.githubItem} />
          {hideSubmitCta ? null : (
            <SubmitLink
              href={href("/submit")}
              label={t("submitCta")}
              variant="desktop"
            />
          )}
          <MobileNav
            items={nav.allNav}
            githubItem={nav.githubItem}
            submitHref={href("/submit")}
            submitLabel={t("submitCta")}
            openMenuLabel={t("openMenu")}
            hideSubmitCta={hideSubmitCta}
          />
          <AuthBadge compact />
        </div>
      </nav>
    </header>
  );
}
