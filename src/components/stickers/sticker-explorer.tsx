"use client";

import Image from "next/image";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import {
  Check,
  ChevronRight,
  Copy,
  Download,
  Plus,
  Share2,
  X,
} from "lucide-react";

import {
  type PetStickerFormat,
  petStickerFilename,
} from "@/lib/pet-sticker-artifacts";
import {
  parseStickerDeck,
  parseStickerExplorerSelection,
  STICKER_DECK_LIMIT,
  STICKER_REACTION_STATES,
  type StickerDeckItem,
  upsertStickerExplorerParams,
} from "@/lib/sticker-explorer-url";
import type { StickerCollection } from "@/lib/sticker-export";

type Labels = {
  reaction: string;
  pet: string;
  treatment: string;
  clean: string;
  outline: string;
  copy: string;
  copied: string;
  download: string;
  nextPet: string;
  addToDeck: string;
  deck: string;
  emptyDeck: string;
  shareDeck: string;
  shared: string;
  deckFull: string;
  reactions: Record<string, string>;
};

export function StickerExplorer({
  collection,
  initialQuery,
  labels,
  demo = false,
}: {
  collection: StickerCollection;
  initialQuery: string;
  labels: Labels;
  demo?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const petSlugs = useMemo(
    () => collection.pets.map((pet) => pet.slug),
    [collection.pets],
  );
  const initialParams = useMemo(
    () => new URLSearchParams(initialQuery),
    [initialQuery],
  );
  const [selection, setSelection] = useState(() =>
    parseStickerExplorerSelection(initialParams, petSlugs),
  );
  const [deck, setDeck] = useState(() =>
    parseStickerDeck(initialParams.get("deck"), petSlugs),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const selectedPet =
    collection.pets.find((pet) => pet.slug === selection.pet) ??
    collection.pets[0];
  const previewUrl = stickerAssetUrl(selection, "webp", demo);

  function sync(nextSelection: StickerDeckItem, nextDeck = deck) {
    setSelection(nextSelection);
    setDeck(nextDeck);
    const params = upsertStickerExplorerParams(
      new URLSearchParams(searchParams.toString()),
      nextSelection,
      nextDeck,
    );
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  async function copySticker() {
    try {
      const response = await fetch(stickerAssetUrl(selection, "png", demo));
      if (!response.ok) throw new Error("copy failed");
      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      showNotice(labels.copied);
    } catch {
      await navigator.clipboard.writeText(
        new URL(previewUrl, window.location.origin).toString(),
      );
      showNotice(labels.copied);
    }
  }

  function addToDeck() {
    const key = JSON.stringify(selection);
    if (deck.some((item) => JSON.stringify(item) === key)) return;
    if (deck.length >= STICKER_DECK_LIMIT) {
      showNotice(labels.deckFull);
      return;
    }
    sync(selection, [...deck, selection]);
  }

  async function shareDeck() {
    const params = upsertStickerExplorerParams(
      new URLSearchParams(searchParams.toString()),
      selection,
      deck,
    );
    await navigator.clipboard.writeText(
      `${window.location.origin}${pathname}?${params.toString()}`,
    );
    showNotice(labels.shared);
  }

  function showNotice(value: string) {
    setNotice(value);
    window.setTimeout(() => setNotice(null), 1800);
  }

  function nextPet() {
    const index = petSlugs.indexOf(selection.pet);
    sync({
      ...selection,
      pet: petSlugs[(index + 1) % petSlugs.length] ?? selection.pet,
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <section className="overflow-hidden rounded-[28px] border border-border-base bg-surface shadow-sm">
        <div className="relative grid min-h-[430px] place-items-center overflow-hidden bg-[linear-gradient(45deg,rgba(120,120,120,.08)_25%,transparent_25%),linear-gradient(-45deg,rgba(120,120,120,.08)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,rgba(120,120,120,.08)_75%),linear-gradient(-45deg,transparent_75%,rgba(120,120,120,.08)_75%)] bg-[length:24px_24px] bg-[position:0_0,0_12px,12px_-12px,-12px_0] p-8 sm:min-h-[560px]">
          <div className="absolute top-5 left-5 rounded-full border border-border-base bg-background/85 px-3 py-1.5 font-mono text-[11px] tracking-[0.18em] text-muted-2 uppercase backdrop-blur">
            {selectedPet.displayName} · {labels.reactions[selection.state]}
          </div>
          <Image
            key={previewUrl}
            src={previewUrl}
            alt={`${selectedPet.displayName} ${labels.reactions[selection.state]}`}
            width={360}
            height={360}
            unoptimized
            className="size-[280px] object-contain [image-rendering:pixelated] sm:size-[380px]"
            priority
          />
          {notice ? (
            <div className="absolute right-5 bottom-5 inline-flex items-center gap-2 rounded-full bg-inverse px-4 py-2 text-sm font-medium text-on-inverse shadow-lg">
              <Check className="size-4" />
              {notice}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-border-base p-4 sm:p-5">
          <button
            type="button"
            onClick={copySticker}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-brand px-5 text-sm font-semibold text-white transition hover:brightness-110"
          >
            <Copy className="size-4" />
            {labels.copy}
          </button>
          <a
            href={downloadUrl(selection, demo)}
            download={petStickerFilename(
              selection.pet,
              selection.state,
              "webp",
              selection.treatment,
            )}
            className="inline-flex h-11 items-center gap-2 rounded-full border border-border-base bg-background px-5 text-sm font-semibold transition hover:bg-surface-muted"
          >
            <Download className="size-4" />
            {labels.download}
          </a>
          <button
            type="button"
            onClick={addToDeck}
            className="inline-flex h-11 items-center gap-2 rounded-full border border-border-base bg-background px-5 text-sm font-semibold transition hover:bg-surface-muted"
          >
            <Plus className="size-4" />
            {labels.addToDeck}
          </button>
          <button
            type="button"
            onClick={nextPet}
            className="ml-auto inline-flex h-11 items-center gap-2 rounded-full px-4 text-sm font-medium text-muted-1 transition hover:bg-surface-muted hover:text-foreground"
          >
            {labels.nextPet}
            <ChevronRight className="size-4" />
          </button>
        </div>
      </section>

      <aside className="space-y-5">
        <Control title={labels.reaction}>
          <div className="flex flex-wrap gap-2">
            {STICKER_REACTION_STATES.map((state) => (
              <Choice
                key={state}
                selected={selection.state === state}
                onClick={() => sync({ ...selection, state })}
              >
                {labels.reactions[state]}
              </Choice>
            ))}
          </div>
        </Control>

        <Control title={labels.pet}>
          <div className="grid grid-cols-2 gap-2">
            {collection.pets.map((pet) => (
              <Choice
                key={pet.slug}
                selected={selection.pet === pet.slug}
                onClick={() => sync({ ...selection, pet: pet.slug })}
              >
                {pet.displayName}
              </Choice>
            ))}
          </div>
        </Control>

        <Control title={labels.treatment}>
          <div className="grid grid-cols-2 gap-2">
            {(["clean", "outline"] as const).map((treatment) => (
              <Choice
                key={treatment}
                selected={selection.treatment === treatment}
                onClick={() => sync({ ...selection, treatment })}
              >
                {labels[treatment]}
              </Choice>
            ))}
          </div>
        </Control>

        <div className="rounded-3xl border border-border-base bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">{labels.deck}</h2>
            <span className="font-mono text-xs text-muted-2">
              {deck.length}/{STICKER_DECK_LIMIT}
            </span>
          </div>
          {deck.length === 0 ? (
            <p className="mt-3 text-sm leading-6 text-muted-2">
              {labels.emptyDeck}
            </p>
          ) : (
            <div className="mt-3 grid grid-cols-4 gap-2">
              {deck.map((item) => {
                const key = `${item.pet}.${item.state}.${item.treatment}`;
                return (
                  <div
                    key={key}
                    className="group relative aspect-square rounded-xl bg-background"
                  >
                    <button
                      type="button"
                      onClick={() => sync(item)}
                      className="grid size-full place-items-center"
                    >
                      <Image
                        src={stickerAssetUrl(item, "webp", demo)}
                        alt=""
                        width={72}
                        height={72}
                        unoptimized
                        className="size-[72px] object-contain [image-rendering:pixelated]"
                      />
                    </button>
                    <button
                      type="button"
                      aria-label="Remove"
                      onClick={() =>
                        sync(
                          selection,
                          deck.filter(
                            (candidate) =>
                              JSON.stringify(candidate) !==
                              JSON.stringify(item),
                          ),
                        )
                      }
                      className="absolute -top-1 -right-1 grid size-5 place-items-center rounded-full bg-inverse text-on-inverse opacity-0 transition group-hover:opacity-100 focus:opacity-100"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <button
            type="button"
            onClick={shareDeck}
            disabled={deck.length === 0}
            className="mt-4 inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-inverse text-sm font-semibold text-on-inverse transition hover:bg-inverse-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Share2 className="size-4" />
            {labels.shareDeck}
          </button>
        </div>
      </aside>
    </div>
  );
}

function Control({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-3xl border border-border-base bg-surface p-4">
      <h2 className="mb-3 font-mono text-[11px] tracking-[0.18em] text-muted-2 uppercase">
        {title}
      </h2>
      {children}
    </div>
  );
}

function Choice({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`min-h-10 rounded-full border px-3 text-sm font-medium transition ${
        selected
          ? "border-brand bg-brand/12 text-brand"
          : "border-border-base bg-background text-muted-1 hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

function stickerAssetUrl(
  item: StickerDeckItem,
  format: PetStickerFormat,
  demo: boolean,
): string {
  if (demo) {
    return `/sticker-review/${item.pet}/${petStickerFilename(
      item.pet,
      item.state,
      format,
      item.treatment,
    )}`;
  }
  const params = new URLSearchParams({
    state: item.state,
    format,
    treatment: item.treatment,
  });
  return `/api/pets/${item.pet}/sticker?${params.toString()}`;
}

function downloadUrl(item: StickerDeckItem, demo: boolean): string {
  return stickerAssetUrl(item, "webp", demo);
}
