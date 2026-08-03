import { notFound } from "next/navigation";

import { getTranslations, setRequestLocale } from "next-intl/server";

import { buildLocaleAlternates } from "@/lib/locale-routing";
import { PET_STICKER_STATES } from "@/lib/pet-sticker-artifacts";
import {
  getStickerCollection,
  type StickerCollection,
} from "@/lib/sticker-export";
import {
  STICKER_PUBLIC_FORMATS,
  STICKER_PUBLIC_TREATMENTS,
} from "@/lib/sticker-export-policy";

import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { StickerExplorer } from "@/components/stickers/sticker-explorer";

import { defaultLocale, hasLocale } from "@/i18n/config";

export const dynamic = "force-dynamic";

type PageProps = {
  params: Promise<{ collection: string; locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps) {
  const { collection, locale } = await params;
  return {
    title: `${collection === "claude" ? "Claude" : collection} reactions`,
    description: "Pick a reaction, copy the sticker, or share a reaction deck.",
    alternates: buildLocaleAlternates(
      `/stickers/${collection}`,
      hasLocale(locale) ? locale : undefined,
    ),
  };
}

export default async function StickerCollectionPage({
  params,
  searchParams,
}: PageProps) {
  const { collection: collectionSlug, locale } = await params;
  const localeValue = hasLocale(locale) ? locale : defaultLocale;
  setRequestLocale(localeValue);
  const demo = process.env.STICKER_EXPLORER_DEMO === "1";
  const collection = demo
    ? demoCollection(collectionSlug)
    : await getStickerCollection(collectionSlug);
  if (!collection || collection.pets.length === 0) notFound();
  const query = await searchParams;
  const initialQuery = new URLSearchParams(
    Object.entries(query).flatMap(([key, value]) =>
      Array.isArray(value)
        ? value.map((entry) => [key, entry] as [string, string])
        : value
          ? [[key, value] as [string, string]]
          : [],
    ),
  ).toString();
  const t = await getTranslations({
    locale: localeValue,
    namespace: "stickers",
  });
  const labels = {
    reaction: t("reaction"),
    pet: t("pet"),
    treatment: t("treatment"),
    clean: t("clean"),
    outline: t("outline"),
    copy: t("copy"),
    copied: t("copied"),
    download: t("download"),
    nextPet: t("nextPet"),
    addToDeck: t("addToDeck"),
    deck: t("deck"),
    emptyDeck: t("emptyDeck"),
    shareDeck: t("shareDeck"),
    shared: t("shared"),
    deckFull: t("deckFull"),
    reactions: Object.fromEntries(
      PET_STICKER_STATES.map((state) => [state, t(`reactions.${state}`)]),
    ),
  };

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <SiteHeader />
      <section className="mx-auto w-full max-w-[1440px] px-5 py-10 md:px-8 md:py-16">
        <p className="font-mono text-xs tracking-[0.22em] text-brand uppercase">
          {t("eyebrow")}
        </p>
        <div className="mt-3 mb-8 flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <h1 className="text-balance text-4xl font-semibold tracking-tight md:text-6xl">
              {t("title", { collection: collection.title })}
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-muted-1 md:text-lg">
              {t("description")}
            </p>
          </div>
          <p className="font-mono text-xs text-muted-2">
            {t("count", { count: collection.pets.length })}
          </p>
        </div>
        <StickerExplorer
          collection={collection}
          initialQuery={initialQuery}
          labels={labels}
          demo={demo}
        />
      </section>
      <SiteFooter />
    </main>
  );
}

function demoCollection(slug: string): StickerCollection | null {
  if (slug !== "claude") return null;
  return {
    slug: "claude",
    title: "Claude",
    description: "Claude Code pets turned into reactions.",
    pets: [
      {
        id: "demo-claude-crab",
        slug: "claude-crab",
        displayName: "Claude Crab",
        description:
          "A tiny orange blocky Claude Code mascot pet with black square eyes and four little legs.",
        dominantColor: "#fc7434",
        states: [...PET_STICKER_STATES],
        formats: [...STICKER_PUBLIC_FORMATS],
        treatments: [...STICKER_PUBLIC_TREATMENTS],
      },
      {
        id: "demo-claude-spectacles-3",
        slug: "claude-spectacles-3",
        displayName: "Claude Spectacles",
        description:
          "A warm black-and-white pixel cat with Claude-specific reaction states.",
        dominantColor: "#d79444",
        states: [...PET_STICKER_STATES],
        formats: [...STICKER_PUBLIC_FORMATS],
        treatments: [...STICKER_PUBLIC_TREATMENTS],
      },
      {
        id: "demo-clawd-music",
        slug: "clawd-music",
        displayName: "Clawd",
        description: "A tiny Claude Code mascot with headphones.",
        dominantColor: "#dc7454",
        states: [...PET_STICKER_STATES],
        formats: [...STICKER_PUBLIC_FORMATS],
        treatments: [...STICKER_PUBLIC_TREATMENTS],
      },
    ],
  };
}
