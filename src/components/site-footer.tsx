import Link from "next/link";

import { useTranslations } from "next-intl";

import { DiscordLink } from "@/components/discord-link";
import { SponsorButton } from "@/components/sponsor-button";

export function SiteFooter() {
  const t = useTranslations("footer");

  return (
    <footer className="mx-auto w-full max-w-[1440px] px-5 py-10 md:px-8">
      <div className="flex flex-col items-start justify-between gap-3 border-t border-border-base pt-6 text-xs text-muted-3 md:flex-row md:items-center">
        <p>{t("rightsNotice")}</p>
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/leaderboard"
            className="underline underline-offset-4 transition hover:text-foreground"
          >
            {t("topCreators")}
          </Link>
          <Link
            href="/legal/takedown"
            className="underline underline-offset-4 transition hover:text-foreground"
          >
            {t("takedown")}
          </Link>
          <Link
            href="/advertise"
            className="underline underline-offset-4 transition hover:text-foreground"
          >
            {t("advertise")}
          </Link>
          <a
            href="https://github.com/crafter-station/petdex"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 transition hover:text-foreground"
          >
            {t("github")}
          </a>
          {process.env.NEXT_PUBLIC_DISCORD_INVITE_URL ? (
            <DiscordLink
              href={process.env.NEXT_PUBLIC_DISCORD_INVITE_URL}
              source="footer"
              className="underline underline-offset-4 transition hover:text-foreground"
            >
              {t("discord")}
            </DiscordLink>
          ) : null}
          <SponsorButton variant="inline" />
        </div>
      </div>
    </footer>
  );
}
