"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Loader2, Lock, Pencil, Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";

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
          <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
            {t("title")}
          </p>
          <p className="mt-1 text-sm text-muted-3">
            {t("description")} {personalCount}/{maxCollections} used.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          disabled={atCap || creating || approvedPets.length === 0}
          className="inline-flex h-10 items-center gap-1.5 rounded-full bg-inverse px-4 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover disabled:opacity-50"
        >
          <Plus className="size-4" />
          New collection
        </button>
      </header>

      {approvedPets.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-border-base bg-surface/60 p-8 text-center text-sm text-muted-2">
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
          <div className="rounded-3xl border border-dashed border-border-base bg-surface/60 p-8 text-center text-sm text-muted-2">
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
    <article className="flex items-start gap-4 rounded-2xl border border-border-base bg-surface/70 p-4">
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          {collection.featured ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-brand-tint px-2 py-0.5 font-mono text-[9px] tracking-[0.18em] text-brand-deep uppercase dark:bg-brand-tint-dark dark:text-brand-light">
              <Lock className="size-2.5" />
              Curated
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full border border-border-base bg-surface px-2 py-0.5 font-mono text-[9px] tracking-[0.18em] text-muted-3 uppercase">
              Personal
            </span>
          )}
          <span className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
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
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            aria-label={t("editAria")}
            className="inline-flex size-8 items-center justify-center rounded-full border border-border-base bg-surface text-muted-2 transition hover:border-border-strong hover:text-foreground"
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            aria-label={t("deleteAria")}
            className="inline-flex size-8 items-center justify-center rounded-full border border-border-base bg-surface text-muted-2 transition hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
          >
            {deleting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </button>
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
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
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
        setError(j.error ?? `Save failed (${res.status})`);
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
      className="rounded-2xl border border-brand/30 bg-brand-tint/50 p-5 space-y-4 dark:bg-brand-tint-dark/50"
    >
      <header className="flex items-center justify-between">
        <p className="font-mono text-[11px] tracking-[0.22em] text-brand-deep uppercase dark:text-brand-light">
          {mode === "create" ? "New collection" : "Edit collection"}
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex size-7 items-center justify-center rounded-full border border-border-base bg-surface text-muted-2 transition hover:border-border-strong hover:text-foreground"
          aria-label={t("cancelAria")}
        >
          <X className="size-3.5" />
        </button>
      </header>

      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
          Title
        </span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          minLength={2}
          maxLength={80}
          placeholder={t("namePlaceholder")}
          className="mt-1 h-10 w-full rounded-full border border-border-base bg-surface px-4 text-sm focus:outline-none focus:ring-1 focus:ring-brand"
        />
      </label>

      <label className="block">
        <span className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
          Description (optional)
        </span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={280}
          rows={2}
          placeholder="What ties them together?"
          className="mt-1 w-full rounded-2xl border border-border-base bg-surface px-4 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand"
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
            return (
              <button
                key={pet.slug}
                type="button"
                onClick={() => togglePet(pet.slug)}
                className={`relative flex flex-col items-center gap-1 rounded-xl border p-2 text-xs transition ${
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
      </fieldset>

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="inline-flex h-9 items-center rounded-full border border-border-base bg-surface px-4 text-xs font-medium text-muted-2 transition hover:border-border-strong hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || title.trim().length < 2 || selected.size === 0}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-inverse px-4 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover disabled:opacity-50"
        >
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {mode === "create" ? "Create" : "Save"}
        </button>
      </div>
    </form>
  );
}
