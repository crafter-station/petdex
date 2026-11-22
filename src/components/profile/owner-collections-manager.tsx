"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Loader2, Lock, Pencil, Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";

import {
  collectionPetLimitExceeded,
  MAX_COLLECTION_PETS,
} from "@/lib/collection-constants";

import { Button } from "@/components/ui/button";

type ApprovedPet = {
  slug: string;
  displayName: string;
  spritesheetUrl: string;
};

export type OwnerCollection = {
  id: string;
  slug: string;
  title: string;
  description: string;
  externalUrl: string | null;
  coverPetSlug: string | null;
  petSlugs: string[];
  petCount: number;
  featured: boolean;
};

type Props = {
  collections: OwnerCollection[];
  approvedPets: ApprovedPet[];
  maxCollections: number;
  publicHandle: string;
};

export function OwnerCollectionsManager({
  collections,
  approvedPets,
  maxCollections,
  publicHandle: _publicHandle,
}: Props) {
  const t = useTranslations("ownerCollections");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const personalCount = collections.filter((c) => !c.featured).length;
  const atCap = personalCount >= maxCollections;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="toy-tag text-brand">{t("title")}</p>
          <p className="mt-1 text-sm text-muted-3">
            {t("description")} {personalCount}/{maxCollections} used.
          </p>
        </div>
        <Button
          type="button"
          variant="cobalt"
          size="petdex-pill"
          onClick={() => setCreating(true)}
          disabled={atCap || creating || approvedPets.length === 0}
        >
          <Plus className="size-4" />
          New collection
        </Button>
      </header>

      {approvedPets.length === 0 ? (
        <div className="toy-shell rounded-3xl border border-dashed border-[#D4DCF4] p-8 text-center text-sm text-muted-2 dark:border-white/12">
          You need at least one approved pet to create a collection.
        </div>
      ) : null}

      {creating ? (
        <CollectionForm
          mode="create"
          approvedPets={approvedPets}
          onCancel={() => setCreating(false)}
          onSaved={() => setCreating(false)}
        />
      ) : null}

      <div className="space-y-3">
        {collections.length === 0 && !creating ? (
          <div className="toy-shell rounded-3xl border border-dashed border-[#D4DCF4] p-8 text-center text-sm text-muted-2 dark:border-white/12">
            No collections yet. Group your pets into themed sets that show up on
            your profile.
          </div>
        ) : null}
        {collections.map((c) => {
          if (editingId === c.id) {
            return (
              <CollectionForm
                key={c.id}
                mode="edit"
                collection={c}
                approvedPets={approvedPets}
                onCancel={() => setEditingId(null)}
                onSaved={() => setEditingId(null)}
              />
            );
          }
          return (
            <CollectionCard
              key={c.id}
              collection={c}
              onEdit={() => setEditingId(c.id)}
            />
          );
        })}
      </div>
    </div>
  );
}

function CollectionCard({
  collection,
  onEdit,
}: {
  collection: OwnerCollection;
  onEdit: () => void;
}) {
  const t = useTranslations("ownerCollections");
  const router = useRouter();
  const [deleting, setDeleting] = useState(false);
  const [, startTransition] = useTransition();

  async function handleDelete() {
    if (collection.featured) return;
    if (
      !confirm(
        `Delete "${collection.title}"? Your pets stay on your profile, only the collection card is removed.`,
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      const res = await fetch(`/api/profile/collections/${collection.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        alert(`Could not delete: ${j.error ?? res.statusText}`);
        return;
      }
      startTransition(() => router.refresh());
    } finally {
      setDeleting(false);
    }
  }

  return (
    <article className="toy-shell flex items-start gap-4 rounded-2xl border border-[#D4DCF4] p-4 dark:border-white/12">
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {collection.featured ? (
            <span className="toy-tag inline-flex items-center gap-1 rounded-xl bg-brand-tint px-2 py-0.5 text-brand-deep dark:bg-brand-tint-dark dark:text-brand-light">
              <Lock className="size-2.5" />
              Curated
            </span>
          ) : (
            <span className="toy-tag inline-flex items-center rounded-xl border border-[#D4DCF4] bg-surface px-2 py-0.5 text-muted-3 dark:border-white/12">
              Personal
            </span>
          )}
          <span className="toy-tag text-muted-3">
            {collection.petCount} pets
          </span>
        </div>
        <h3 className="mt-2 text-lg font-semibold tracking-tight text-foreground">
          <Link
            href={`/collections/${collection.slug}`}
            className="hover:underline"
          >
            {collection.title}
          </Link>
        </h3>
        {collection.description ? (
          <p className="mt-1 line-clamp-2 text-sm text-muted-2">
            {collection.description}
          </p>
        ) : null}
      </div>
      {!collection.featured ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="pearl"
            size="icon"
            onClick={onEdit}
            aria-label={t("editAria")}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="icon"
            onClick={handleDelete}
            disabled={deleting}
            aria-label={t("deleteAria")}
          >
            {deleting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function CollectionForm({
  mode,
  collection,
  approvedPets,
  onCancel,
  onSaved,
}: {
  mode: "create" | "edit";
  collection?: OwnerCollection;
  approvedPets: ApprovedPet[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("ownerCollections");
  const router = useRouter();
  const [title, setTitle] = useState(collection?.title ?? "");
  const [description, setDescription] = useState(collection?.description ?? "");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(collection?.petSlugs ?? []),
  );
  const [coverSlug, _setCoverSlug] = useState<string | null>(
    collection?.coverPetSlug ?? null,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function togglePet(slug: string) {
    if (!selected.has(slug) && selected.size >= MAX_COLLECTION_PETS) {
      setError(t("petLimit", { max: MAX_COLLECTION_PETS }));
      return;
    }
    setError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // A stored collection that predates the cap may already hold more than
    // MAX_COLLECTION_PETS. Blocking that here would make it uneditable — not
    // even a title fix — so only growth past the cap is refused.
    if (
      collectionPetLimitExceeded(
        [...selected],
        mode === "edit" ? (collection?.petSlugs ?? null) : null,
      )
    ) {
      setError(t("petLimit", { max: MAX_COLLECTION_PETS }));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const petSlugs = approvedPets
        .map((p) => p.slug)
        .filter((s) => selected.has(s));
      const body = {
        title: title.trim(),
        description: description.trim(),
        petSlugs,
        coverPetSlug:
          coverSlug && petSlugs.includes(coverSlug)
            ? coverSlug
            : (petSlugs[0] ?? null),
      };
      const url =
        mode === "create"
          ? "/api/profile/collections"
          : `/api/profile/collections/${collection?.id}`;
      const method = mode === "create" ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        // The server refuses an empty member list, because applying one would
        // remove every member and then report a member list the collection does
        // not have. This form cannot send one — save is disabled with nothing
        // selected — so the branch is defensive here; the creator editor, which
        // has no such guard, is the path that actually reaches it. Translated
        // anyway, so a future change to either guard cannot surface the raw code.
        setError(
          j.error === "empty_pet_slugs"
            ? t("emptyPetSlugs")
            : (j.error ?? `Save failed (${res.status})`),
        );
        return;
      }
      onSaved();
      startTransition(() => router.refresh());
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="toy-shell space-y-4 rounded-3xl border border-[#3B59F2]/40 p-5"
    >
      <header className="flex items-center justify-between">
        <p className="toy-tag text-brand-deep dark:text-brand-light">
          {mode === "create" ? "New collection" : "Edit collection"}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onCancel}
          aria-label={t("cancelAria")}
        >
          <X className="size-3.5" />
        </Button>
      </header>

      <label className="block">
        <span className="toy-tag text-muted-3">Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          minLength={2}
          maxLength={80}
          placeholder={t("namePlaceholder")}
          className="mt-1 h-10 w-full rounded-xl border border-[#D4DCF4] bg-surface px-3.5 text-sm focus:border-[#3B59F2] focus:outline-none focus:ring-2 focus:ring-[#3B59F2]/20 dark:border-white/12"
        />
      </label>

      <label className="block">
        <span className="toy-tag text-muted-3">Description (optional)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={280}
          rows={2}
          placeholder="What ties them together?"
          className="mt-1 w-full rounded-xl border border-[#D4DCF4] bg-surface px-3.5 py-2 text-sm focus:border-[#3B59F2] focus:outline-none focus:ring-2 focus:ring-[#3B59F2]/20 dark:border-white/12"
        />
        <span className="mt-1 block text-right text-[10px] text-muted-3">
          {description.length}/280
        </span>
      </label>

      <fieldset>
        <legend className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
          {t("petsSelected", {
            selected: selected.size,
            total: approvedPets.length,
          })}
        </legend>
        <div className="mt-2 grid max-h-72 grid-cols-2 gap-2 overflow-y-auto rounded-2xl border border-border-base bg-surface p-2 sm:grid-cols-3 md:grid-cols-4">
          {approvedPets.map((pet) => {
            const checked = selected.has(pet.slug);
            const selectionFull =
              !checked && selected.size >= MAX_COLLECTION_PETS;
            return (
              <button
                key={pet.slug}
                type="button"
                onClick={() => togglePet(pet.slug)}
                disabled={selectionFull}
                className={`relative flex flex-col items-center gap-1 rounded-xl border p-2 text-xs transition disabled:cursor-not-allowed disabled:opacity-45 ${
                  checked
                    ? "border-brand bg-brand/10 text-foreground"
                    : "border-border-base bg-transparent text-muted-2 hover:border-border-strong hover:text-foreground"
                }`}
              >
                <span className="line-clamp-1 break-all text-center">
                  {pet.displayName}
                </span>
              </button>
            );
          })}
        </div>
        {approvedPets.length > MAX_COLLECTION_PETS ? (
          <p className="mt-2 text-xs text-muted-3">
            {t("petLimitHint", { max: MAX_COLLECTION_PETS })}
          </p>
        ) : null}
      </fieldset>

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="pearl"
          size="lg"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="cobalt"
          size="lg"
          disabled={saving || title.trim().length < 2 || selected.size === 0}
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {mode === "create" ? "Create" : "Save"}
        </Button>
      </div>
    </form>
  );
}
