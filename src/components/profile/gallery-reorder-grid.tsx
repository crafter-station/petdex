"use client";

// Owner-only reorder mode for the full /u/<handle> approved gallery.
// Default render is the regular grid (delegated to children). When the
// owner clicks "Edit order", we swap to a dnd-kit sortable grid with
// drag handles, save on "Done", and exit. We persist via PATCH
// /api/profile/gallery-order which sets gallery_position 1..N.

import { useEffect, useMemo, useRef, useState } from "react";

import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, GripVertical, Loader2, Pencil, X } from "lucide-react";
import { useTranslations } from "next-intl";

import type { PetWithMetrics } from "@/lib/pets";

import { PetSprite } from "@/components/pets/pet-sprite";

type Props = {
  pets: PetWithMetrics[];
  // Render the read-only grid when not in edit mode. The host page
  // already builds this — we just defer to it instead of duplicating
  // the PetCard layout.
  children: React.ReactNode;
};

type SaveState = "idle" | "saving" | "saved" | "error";

// The route answers with these codes; the panel used to render the raw one.
const ERROR_KEYS: Record<string, string> = {
  unauthorized: "unauthorized",
  rate_limited: "rateLimited",
  invalid_order: "invalidOrder",
  too_many_items: "tooManyItems",
  empty_order: "emptyOrder",
  no_owned_pets_in_order: "noOwnedPets",
};

function move<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0) return items;
  if (from >= items.length || to >= items.length) return items;
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function GalleryReorderGrid({ pets, children }: Props) {
  const t = useTranslations("galleryReorder");
  const tProfile = useTranslations("profile");
  const [editing, setEditing] = useState(false);
  const [order, setOrder] = useState<PetWithMetrics[]>(pets);
  const orderRef = useRef<PetWithMetrics[]>(pets);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  // Reset local order whenever the prop changes (e.g. after server
  // refresh pulls the latest gallery_position values).
  useEffect(() => {
    orderRef.current = pets;
    setOrder(pets);
  }, [pets]);

  useEffect(() => {
    if (saveState !== "saved") return;
    const t = window.setTimeout(() => setSaveState("idle"), 1800);
    return () => window.clearTimeout(t);
  }, [saveState]);

  const itemIds = useMemo(() => order.map((p) => p.slug), [order]);
  const activePet = activeSlug
    ? orderRef.current.find((p) => p.slug === activeSlug)
    : null;

  function setNextOrder(next: PetWithMetrics[]) {
    orderRef.current = next;
    setOrder(next);
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveSlug(String(event.active.id));
    setError(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveSlug(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const current = orderRef.current;
    const from = current.findIndex((p) => p.slug === active.id);
    const to = current.findIndex((p) => p.slug === over.id);
    const next = move(current, from, to);
    if (next === current) return;
    setNextOrder(next);
  }

  async function save() {
    setSaveState("saving");
    setError(null);
    try {
      const res = await fetch("/api/profile/gallery-order", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: orderRef.current.map((p) => p.slug) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `http_${res.status}`);
      }
      setSaveState("saved");
      setEditing(false);
      // Tell the page to re-fetch so other consumers (pinned cards, etc)
      // see the new positions on next interaction.
      if (typeof window !== "undefined") window.location.reload();
    } catch (err) {
      setSaveState("error");
      setError((err as Error).message);
    }
  }

  function cancel() {
    setNextOrder(pets);
    setEditing(false);
    setSaveState("idle");
    setError(null);
  }

  if (!editing) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border-base bg-surface/70 px-3 text-xs font-medium text-muted-2 transition hover:border-border-strong hover:text-foreground"
          >
            <Pencil className="size-3" />
            {tProfile("editOrder")}
          </button>
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-brand/30 bg-brand-tint/60 px-3 py-2 dark:bg-brand-tint-dark/60">
        <p className="text-xs text-muted-2">{t("dragInstruction")}</p>
        <div className="flex items-center gap-2">
          {error ? (
            <span role="alert" className="text-xs text-destructive">
              {ERROR_KEYS[error]
                ? t(`errors.${ERROR_KEYS[error]}`)
                : t("saveFailed", { code: error })}
            </span>
          ) : null}
          <button
            type="button"
            onClick={cancel}
            disabled={saveState === "saving"}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border-base bg-surface/80 px-3 text-xs font-medium text-muted-2 transition hover:border-border-strong hover:text-foreground disabled:opacity-50"
          >
            <X className="size-3" />
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saveState === "saving"}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-inverse px-3 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover disabled:opacity-50"
          >
            {saveState === "saving" ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Check className="size-3" />
            )}
            {saveState === "saving" ? t("saving") : t("done")}
          </button>
        </div>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setActiveSlug(null)}
      >
        <SortableContext items={itemIds} strategy={rectSortingStrategy}>
          <div className="grid gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
            {order.map((pet) => (
              <ReorderItem
                key={pet.slug}
                pet={pet}
                isActive={pet.slug === activeSlug}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {activePet ? (
        <div className="pointer-events-none fixed top-0 left-0 z-50 hidden">
          {activePet.displayName}
        </div>
      ) : null}
    </div>
  );
}

function ReorderItem({
  pet,
  isActive,
}: {
  pet: PetWithMetrics;
  isActive: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: pet.slug });
  const tProfile = useTranslations("profile");
  const t = useTranslations("galleryReorder");
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  } satisfies React.CSSProperties;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative flex flex-col items-center gap-2 rounded-2xl border bg-surface/80 p-3 transition ${
        isActive
          ? "border-brand shadow-lg"
          : "border-border-base hover:border-border-strong"
      }`}
    >
      <button
        type="button"
        aria-label={tProfile("dragAria", { name: pet.displayName })}
        className="absolute top-2 right-2 inline-flex size-7 items-center justify-center rounded-full border border-border-base bg-surface text-muted-2 transition hover:border-border-strong hover:text-foreground"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-3.5" />
      </button>
      <div className="pet-sprite-stage flex h-24 w-24 items-center justify-center">
        <PetSprite
          src={pet.spritesheetPath}
          scale={0.7}
          label={t("spriteStill", { name: pet.displayName })}
        />
      </div>
      <p className="line-clamp-1 text-center text-xs font-medium text-muted-1">
        {pet.displayName}
      </p>
    </div>
  );
}
