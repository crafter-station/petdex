"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import {
  Check,
  GripVertical,
  Link as LinkIcon,
  Loader2,
  Save,
  Sparkles,
} from "lucide-react";
import { useTranslations } from "next-intl";

import {
  collectionPetLimitExceeded,
  limitCollectionPetSlugs,
  MAX_COLLECTION_PETS,
} from "@/lib/collection-constants";

import { Button, buttonVariants } from "@/components/ui/button";

type PetOption = {
  slug: string;
  displayName: string;
  spritesheetUrl: string;
};

export type EditableCollection = {
  slug: string;
  title: string;
  description: string;
  externalUrl: string | null;
  coverPetSlug: string | null;
  petSlugs: string[];
} | null;

export function CollectionEditor({
  approvedPets,
  initial,
  profileHandle,
}: {
  approvedPets: PetOption[];
  initial: EditableCollection;
  profileHandle: string;
}) {
  const t = useTranslations("collectionEditor");
  const fallbackTitle = `${profileHandle}'s collection`;
  const [title, setTitle] = useState(initial?.title ?? fallbackTitle);
  const [description, setDescription] = useState(initial?.description ?? "");
  const [externalUrl, setExternalUrl] = useState(initial?.externalUrl ?? "");
  const [petSlugs, setPetSlugs] = useState<string[]>(() =>
    initial
      ? [...new Set(initial.petSlugs)]
      : limitCollectionPetSlugs(
          approvedPets.map((pet) => pet.slug),
          null,
        ),
  );
  const [coverPetSlug, setCoverPetSlug] = useState<string | null>(
    initial?.coverPetSlug ?? petSlugs[0] ?? null,
  );
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const petBySlug = useMemo(
    () => new Map(approvedPets.map((pet) => [pet.slug, pet])),
    [approvedPets],
  );
  const selectedPets = petSlugs
    .map((slug) => petBySlug.get(slug))
    .filter((pet): pet is PetOption => Boolean(pet));

  useEffect(() => {
    if (coverPetSlug && petSlugs.includes(coverPetSlug)) return;
    setCoverPetSlug(petSlugs[0] ?? null);
  }, [coverPetSlug, petSlugs]);

  function togglePet(slug: string) {
    setSaved(false);
    if (!petSlugs.includes(slug) && petSlugs.length >= MAX_COLLECTION_PETS) {
      setError(t("petLimit", { max: MAX_COLLECTION_PETS }));
      return;
    }
    setError(null);
    setPetSlugs((current) =>
      current.includes(slug)
        ? current.filter((item) => item !== slug)
        : [...current, slug],
    );
  }

  function movePet(from: number, to: number) {
    if (from === to) return;
    setSaved(false);
    setPetSlugs((current) => {
      const next = current.slice();
      const [item] = next.splice(from, 1);
      if (!item) return current;
      next.splice(to, 0, item);
      return next;
    });
  }

  function save() {
    setError(null);
    setSaved(false);
    // A stored collection that predates the cap may already hold more than
    // MAX_COLLECTION_PETS. Blocking that here would make it uneditable — not
    // even a title fix — so only growth past the cap is refused.
    if (
      collectionPetLimitExceeded(petSlugs, initial ? initial.petSlugs : null)
    ) {
      setError(t("petLimit", { max: MAX_COLLECTION_PETS }));
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch("/api/profile/collection", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title,
            description,
            externalUrl,
            coverPetSlug,
            petSlugs,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          // Refused because applying an empty list would remove every member
          // and report a member list the collection does not have. This editor
          // does not require a selection to save, so the case is reachable and
          // needs a sentence, not a code.
          setError(
            data.error === "empty_pet_slugs"
              ? t("emptyPetSlugs")
              : (data.error ?? `save_failed_${res.status}`),
          );
          return;
        }
        setSaved(true);
      } catch {
        setError("network_error");
      }
    });
  }

  return (
    <section className="toy-shell rounded-3xl border border-[#D4DCF4] p-5 md:p-6 dark:border-white/12">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="toy-tag text-brand">Featured collection</p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
            Your creator set
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-2">
            Choose the pets, brand copy, hero pet, IP link and display order for
            the collection shown on your public profile.
          </p>
        </div>
        {initial?.slug ? (
          <a
            href={`/collections/${initial.slug}`}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "pearl", size: "lg" })}
          >
            View public collection
          </a>
        ) : null}
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-[1fr_240px]">
        <div className="space-y-3">
          <label className="block">
            <span className="toy-tag text-muted-3">Brand name</span>
            <input
              value={title}
              onChange={(event) => {
                setSaved(false);
                setTitle(event.target.value);
              }}
              maxLength={80}
              className="mt-1 h-11 w-full rounded-xl border border-[#D4DCF4] bg-background px-3 text-sm text-foreground outline-none transition focus:border-[#3B59F2] focus:ring-2 focus:ring-[#3B59F2]/20 dark:border-white/12"
            />
          </label>
          <label className="block">
            <span className="toy-tag text-muted-3">Description</span>
            <textarea
              value={description}
              onChange={(event) => {
                setSaved(false);
                setDescription(event.target.value);
              }}
              maxLength={280}
              rows={3}
              className="mt-1 w-full resize-none rounded-xl border border-[#D4DCF4] bg-background px-3 py-2 text-sm leading-6 text-foreground outline-none transition focus:border-[#3B59F2] focus:ring-2 focus:ring-[#3B59F2]/20 dark:border-white/12"
            />
          </label>
          <label className="block">
            <span className="toy-tag text-muted-3">Visit IP site URL</span>
            <div className="mt-1 flex h-11 items-center gap-2 rounded-xl border border-[#D4DCF4] bg-background px-3 focus-within:border-[#3B59F2] focus-within:ring-2 focus-within:ring-[#3B59F2]/20 dark:border-white/12">
              <LinkIcon className="size-4 text-muted-4" />
              <input
                value={externalUrl}
                onChange={(event) => {
                  setSaved(false);
                  setExternalUrl(event.target.value);
                }}
                placeholder="https://graycraft.com"
                className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-4"
              />
            </div>
          </label>
        </div>

        <div className="rounded-2xl border border-[#D4DCF4] bg-background/70 p-3 dark:border-white/12">
          <span className="toy-tag text-muted-3">Hero pet</span>
          <select
            value={coverPetSlug ?? ""}
            onChange={(event) => {
              setSaved(false);
              setCoverPetSlug(event.target.value || null);
            }}
            disabled={selectedPets.length === 0}
            className="mt-1 h-10 w-full rounded-xl border border-[#D4DCF4] bg-surface px-2 text-xs text-foreground outline-none disabled:opacity-50 dark:border-white/12"
          >
            {selectedPets.length === 0 ? (
              <option value="">{t("selectPetsFirst")}</option>
            ) : null}
            {selectedPets.map((pet) => (
              <option key={pet.slug} value={pet.slug}>
                {pet.displayName}
              </option>
            ))}
          </select>
          <div className="mt-3 rounded-2xl border border-dashed border-[#D4DCF4] bg-surface-muted/50 p-3 text-center dark:border-white/12">
            <Sparkles className="mx-auto size-5 text-brand" />
            <p className="mt-2 text-xs leading-5 text-muted-2">
              This pet anchors the collection hero on your profile and the
              collection page.
            </p>
          </div>
        </div>
      </div>

      {approvedPets.length === 0 ? (
        <p className="mt-5 rounded-2xl border border-dashed border-[#D4DCF4] bg-background/70 p-5 text-sm text-muted-2 dark:border-white/12">
          You need at least one approved pet before you can build a collection.
        </p>
      ) : (
        <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_1fr]">
          <div>
            <p className="toy-tag text-muted-3">Pets in collection</p>
            {approvedPets.length > MAX_COLLECTION_PETS ? (
              <p className="mt-1 text-xs text-muted-3">
                {t("petLimitHint", { max: MAX_COLLECTION_PETS })}
              </p>
            ) : null}
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {approvedPets.map((pet) => {
                const selected = petSlugs.includes(pet.slug);
                const selectionFull =
                  !selected && petSlugs.length >= MAX_COLLECTION_PETS;
                return (
                  <button
                    key={pet.slug}
                    type="button"
                    onClick={() => togglePet(pet.slug)}
                    disabled={selectionFull}
                    aria-pressed={selected}
                    className={`flex h-11 cursor-pointer items-center justify-between rounded-xl border px-3 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-45 ${
                      selected
                        ? "border-[#3B59F2]/50 bg-[#EEF2FF]/80 text-[#2943CC] dark:bg-[#3B59F2]/15 dark:text-[#8CA3FF]"
                        : "border-[#D4DCF4] bg-background text-muted-2 hover:border-[#3B59F2]/40 hover:text-foreground dark:border-white/12"
                    }`}
                  >
                    <span className="min-w-0 truncate">{pet.displayName}</span>
                    {selected ? <Check className="size-4 shrink-0" /> : null}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="toy-tag text-muted-3">Featured order</p>
            <div className="mt-2 space-y-2">
              {selectedPets.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[#D4DCF4] bg-background/70 p-5 text-sm text-muted-2 dark:border-white/12">
                  Select pets to order the collection.
                </div>
              ) : (
                selectedPets.map((pet, index) => (
                  <button
                    key={pet.slug}
                    type="button"
                    draggable
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (dragIndex !== null) movePet(dragIndex, index);
                      setDragIndex(null);
                    }}
                    onDragEnd={() => setDragIndex(null)}
                    className="flex h-11 w-full cursor-grab items-center gap-2 rounded-xl border border-[#D4DCF4] bg-background px-3 text-left text-sm text-foreground active:cursor-grabbing dark:border-white/12"
                  >
                    <GripVertical className="size-4 text-muted-4" />
                    <span className="font-mono text-[10px] text-muted-4">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {pet.displayName}
                    </span>
                    {pet.slug === coverPetSlug ? (
                      <span className="toy-tag rounded-xl bg-brand/15 px-2 py-0.5 text-brand ring-1 ring-brand/25">
                        Hero
                      </span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        {error ? (
          <p className="mr-auto font-mono text-[10px] tracking-[0.12em] text-rose-600 uppercase">
            {error.replace(/_/g, " ")}
          </p>
        ) : null}
        {saved ? (
          <p className="mr-auto inline-flex items-center gap-1 font-mono text-[10px] tracking-[0.12em] text-emerald-600 uppercase">
            <Check className="size-3" />
            Saved
          </p>
        ) : null}
        <Button
          type="button"
          variant="cobalt"
          size="petdex-pill"
          onClick={save}
          disabled={
            pending ||
            title.trim().length < 2 ||
            title.trim().length > 80 ||
            description.length > 280
          }
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Save collection
        </Button>
      </div>
    </section>
  );
}
