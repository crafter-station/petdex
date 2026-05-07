// /community — landing for the Discord server. Hidden until
// NEXT_PUBLIC_DISCORD_INVITE_URL is set: until the server is live a
// "Coming soon" stub is more confusing than no page at all, so we
// 404. The footer + header stop linking to /community for the same
// reason — those guards live in their own components.

import { notFound } from "next/navigation";

import { ArrowRight, Hash, Mic2, Sparkles, Users } from "lucide-react";

import { buildLocaleAlternates } from "@/lib/locale-routing";

import { DiscordLink } from "@/components/discord-link";
import { JsonLd } from "@/components/json-ld";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

export const dynamic = "force-static";
const SITE_URL = "https://petdex.crafter.run";

export async function generateMetadata() {
  if (!process.env.NEXT_PUBLIC_DISCORD_INVITE_URL) {
    return {
      title: "Not found",
      robots: { index: false, follow: false },
    };
  }
  return {
    title: "Petdex Community on Discord",
    description:
      "Join creators, collectors, and the Petdex team in our Discord — featured creator spotlights, work-in-progress feedback, and weekly builds.",
    alternates: buildLocaleAlternates("/community"),
  };
}

const SECTIONS: Array<{
  icon: React.ReactNode;
  title: string;
  body: string;
}> = [
  {
    icon: <Sparkles className="size-4" />,
    title: "Featured creators get the spotlight",
    body: "GRAYCRAFT, Scientific Minds, Crafter Originals — every collection has a real creator behind it. The Discord is where they hang out, take feedback, and pick what ships next.",
  },
  {
    icon: <Hash className="size-4" />,
    title: "Channels for shipping, not vibing only",
    body: "#wip for in-progress sprites, #cli-feedback for bug reports, #ideas synced with the public wishlist on the site, #ship-or-sink for weekend competitions.",
  },
  {
    icon: <Users className="size-4" />,
    title: "Roles you earn by playing",
    body: "@Creator unlocks when your first pet is approved. @Collector at three caught pets. @Featured Creator when your set lands as a curated collection.",
  },
  {
    icon: <Mic2 className="size-4" />,
    title: "Voice rooms that aren't dead",
    body: "co-working for silent focus, pixel-jam for live sprite-art collabs, office-hours with the Petdex team Fridays 4pm GMT-5.",
  },
];

export default function CommunityPage() {
  const inviteUrl = process.env.NEXT_PUBLIC_DISCORD_INVITE_URL;
  if (!inviteUrl) notFound();
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Petdex Community on Discord",
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
              Petdex Community
            </p>
            <h1 className="mt-3 text-balance text-[40px] leading-[1] font-semibold tracking-tight md:text-[64px]">
              Build pixel pets in good company
            </h1>
            <p className="mt-5 text-balance text-base leading-7 text-muted-1 md:text-lg">
              The Petdex Community on Discord — creators, collectors, and the
              team behind the gallery. WIP feedback, weekly builds, featured
              creator spotlights.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <DiscordLink
                href={inviteUrl}
                source="community_page_hero"
                className="inline-flex h-11 items-center gap-2 rounded-full bg-[#5865F2] px-5 text-sm font-semibold text-white transition hover:bg-[#4752c4]"
              >
                Join the Discord
                <ArrowRight className="size-4" />
              </DiscordLink>
              <a
                href="https://github.com/crafter-station/petdex"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-11 items-center rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong"
              >
                Star on GitHub
              </a>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-5xl gap-4 px-5 py-12 md:grid-cols-2 md:px-8 md:py-16">
        {SECTIONS.map((s) => (
          <article
            key={s.title}
            className="flex flex-col gap-3 rounded-3xl border border-border-base bg-surface/80 p-6"
          >
            <span className="grid size-8 place-items-center rounded-full bg-brand-tint text-brand dark:bg-brand-tint-dark">
              {s.icon}
            </span>
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {s.title}
            </h2>
            <p className="text-sm leading-6 text-muted-2">{s.body}</p>
          </article>
        ))}
      </section>

      <section className="mx-auto w-full max-w-5xl px-5 pb-20 md:px-8">
        <div className="rounded-3xl border border-border-base bg-surface/80 p-6 md:p-10">
          <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
            Rules
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight md:text-3xl">
            Be kind, be specific, ship something
          </h2>
          <ul className="mt-4 grid list-disc gap-2 pl-5 text-sm leading-6 text-muted-2 md:grid-cols-2">
            <li>No racism, sexism, or hate speech. Bans are immediate.</li>
            <li>No spam, no DM solicitation, no NFT shilling.</li>
            <li>Critique sprites, not creators. Honest, kind, specific.</li>
            <li>English / Spanish / Chinese channels welcome — pick yours.</li>
            <li>Pet IP belongs to the original creator. Credit always.</li>
            <li>Petdex Team mod log is public in #bot-logs (no secrets).</li>
          </ul>
        </div>
      </section>

      <SiteFooter />
    </main>
  );
}
