// /community — landing for the Discord server. Hidden until
// NEXT_PUBLIC_DISCORD_INVITE_URL is set: until the server is live a
// "Coming soon" stub is more confusing than no page at all, so we
// 404. The footer + header stop linking to /community for the same
// reason — those guards live in their own components.

import { notFound } from "next/navigation";

import { Hash, Mic2, Sparkles, Users } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { buildLocaleAlternates } from "@/lib/locale-routing";

import { DiscordLink } from "@/components/discord-link";
import { DiscordIcon } from "@/components/icons/wechat-icon";
import { JsonLd } from "@/components/json-ld";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import {
  WechatCommunityDialog,
  WechatCommunityQrCard,
} from "@/components/wechat-community-dialog";

import { hasLocale } from "@/i18n/config";

export const dynamic = "force-static";
const SITE_URL = "https://petdex.crafter.run";
const WECHAT_COMMUNITY_ENABLED =
  process.env.NEXT_PUBLIC_WECHAT_COMMUNITY_ENABLED === "1";

type PageProps = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "community.metadata" });
  const hasWechat = locale === "zh" && WECHAT_COMMUNITY_ENABLED;
  if (!process.env.NEXT_PUBLIC_DISCORD_INVITE_URL && !hasWechat) {
    return {
      title: "Not found",
      robots: { index: false, follow: false },
    };
  }
  return {
    title: t("title"),
    description: t("description"),
    alternates: buildLocaleAlternates(
      "/community",
      hasLocale(locale) ? locale : undefined,
    ),
  };
}

const SECTIONS: Array<{
  icon: React.ReactNode;
  key: "spotlight" | "channels" | "roles" | "voice";
}> = [
  {
    icon: <Sparkles className="size-4" />,
    key: "spotlight",
  },
  {
    icon: <Hash className="size-4" />,
    key: "channels",
  },
  {
    icon: <Users className="size-4" />,
    key: "roles",
  },
  {
    icon: <Mic2 className="size-4" />,
    key: "voice",
  },
];

export default async function CommunityPage({ params }: PageProps) {
  const { locale } = await params;
  const t = await getTranslations("community");
  const inviteUrl = process.env.NEXT_PUBLIC_DISCORD_INVITE_URL;
  const isZh = locale === "zh";
  const showWechatCommunity = isZh && WECHAT_COMMUNITY_ENABLED;
  if (!inviteUrl && !showWechatCommunity) notFound();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: t("metadata.title"),
    url: `${SITE_URL}/community`,
  };

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <JsonLd data={jsonLd} />
      <SiteHeader />
      <section className="petdex-cloud relative -mt-[84px] overflow-clip pt-[84px]">
        <div className="relative mx-auto flex w-full max-w-5xl flex-col px-5 pb-12 md:px-8">
          <div className="mt-12 max-w-2xl md:mt-16">
            <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
              {t("eyebrow")}
            </p>
            <h1 className="mt-3 text-balance text-[40px] leading-[1] font-semibold tracking-tight md:text-[64px]">
              {t("title")}
            </h1>
            <p className="mt-5 text-balance text-base leading-7 text-muted-1 md:text-lg">
              {t("description")}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              {isZh ? (
                <WechatCommunityDialog>{t("joinWeChat")}</WechatCommunityDialog>
              ) : inviteUrl ? (
                <DiscordLink
                  href={inviteUrl}
                  source="community_page_hero"
                  className="inline-flex h-11 items-center gap-2 rounded-full border border-[#5865F2]/25 bg-[#5865F2]/10 px-5 text-sm font-semibold text-[#5865F2] backdrop-blur transition hover:bg-[#5865F2]/16"
                >
                  <DiscordIcon className="size-4" />
                  {t("joinDiscord")}
                </DiscordLink>
              ) : null}
              <a
                href="https://github.com/crafter-station/petdex"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 items-center rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong"
              >
                {t("starGithub")}
              </a>
            </div>
            {isZh ? <WechatCommunityQrCard /> : null}
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-5xl gap-4 px-5 py-12 md:grid-cols-2 md:px-8 md:py-16">
        {SECTIONS.map((s) => (
          <article
            key={s.key}
            className="flex flex-col gap-3 rounded-3xl border border-border-base bg-surface/80 p-6"
          >
            <span className="grid size-8 place-items-center rounded-full bg-brand-tint text-brand dark:bg-brand-tint-dark">
              {s.icon}
            </span>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {t(`sections.${s.key}.title`)}
            </h2>
            <p className="text-sm leading-6 text-muted-2">
              {t(`sections.${s.key}.body`)}
            </p>
          </article>
        ))}
      </section>

      <section className="mx-auto w-full max-w-5xl px-5 pb-20 md:px-8">
        <div className="rounded-3xl border border-border-base bg-surface/80 p-6 md:p-10">
          <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
            {t("rules.eyebrow")}
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">
            {t("rules.title")}
          </h2>
          <ul className="mt-4 grid list-disc gap-2 pl-5 text-sm leading-6 text-muted-2 md:grid-cols-2">
            {["respect", "spam", "critique", "languages", "ip", "modlog"].map(
              (key) => (
                <li key={key}>{t(`rules.items.${key}`)}</li>
              ),
            )}
          </ul>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
