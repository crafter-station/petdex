import Link from "next/link";

import { useTranslations } from "next-intl";

import { SponsorButton } from "@/components/brand/sponsor-button";
import { DiscordLink } from "@/components/community/discord-link";

export function SiteFooter() {
  const t = useTranslations("footer");

  return (
    <footer className="mx-auto w-full max-w-[1440px] px-5 py-10 md:px-8">
      <div className="flex flex-col items-start justify-between gap-3 border-t border-[#D4DCF4] pt-6 text-xs text-muted-3 md:flex-row md:items-center dark:border-white/12">
        <div className="space-y-1">
          <p>{t("rightsNotice")}</p>
          <p className="text-muted-3">
            Built by{" "}
            <a
              href="https://railly.dev"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline underline-offset-4 transition hover:text-[#2943CC] dark:hover:text-[#8CA3FF]"
            >
              Railly Hugo
            </a>{" "}
            at{" "}
            <a
              href="https://crafter.run"
              target="_blank"
              rel="noreferrer"
              className="font-medium text-foreground underline underline-offset-4 transition hover:text-[#2943CC] dark:hover:text-[#8CA3FF]"
            >
              Crafter Station
            </a>
            .
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/leaderboard"
            prefetch={false}
            className="underline underline-offset-4 transition hover:text-[#2943CC] dark:hover:text-[#8CA3FF]"
          >
            {t("topCreators")}
          </Link>
          <Link
            href="/legal/takedown"
            prefetch={false}
            className="underline underline-offset-4 transition hover:text-[#2943CC] dark:hover:text-[#8CA3FF]"
          >
            {t("takedown")}
          </Link>
          <Link
            href="/brand"
            prefetch={false}
            className="underline underline-offset-4 transition hover:text-[#2943CC] dark:hover:text-[#8CA3FF]"
          >
            {t("brand")}
          </Link>
          <a
            href="https://github.com/crafter-station/petdex"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-4 transition hover:text-[#2943CC] dark:hover:text-[#8CA3FF]"
          >
            {t("github")}
          </a>
          {process.env.NEXT_PUBLIC_DISCORD_INVITE_URL ? (
            <DiscordLink
              href={process.env.NEXT_PUBLIC_DISCORD_INVITE_URL}
              source="footer"
              className="underline underline-offset-4 transition hover:text-[#2943CC] dark:hover:text-[#8CA3FF]"
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
