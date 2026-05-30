"use client";

// Owner-only reorderable pinned-pets grid for /u/<handle>. The pinned set is
// capped at 6; dnd-kit gives us GitHub-like drag overlays, placeholder slots,
// pointer/touch support, and keyboard sorting without a custom drag engine.

import { useEffect, useMemo, useRef, useState } from "react";

import {
  closestCenter,
  DndContext,
  type DragCancelEvent,
  type DragEndEvent,
  DragOverlay,
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
import { Check, GripVertical, RefreshCcw } from "lucide-react";
import { useTranslations } from "next-intl";

import type { PetWithMetrics } from "@/lib/pets";
import { MAX_PINNED_PETS } from "@/lib/profiles";

import { PetCard } from "@/components/pet-gallery";

type PinnedReorderGridProps = {
  pets: PetWithMetrics[];
  petStateCount: number;
  hideAuthor?: boolean;
};

type SaveState = "idle" | "saving" | "saved" | "error";

type ActiveDrag = {
  slug: string;
  width?: number;
  height?: number;
};

export function movePinnedPets<T>(items: T[], from: number, to: number): T[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= items.length ||
    to >= items.length
  ) {
    return items;
  }
  const next = items.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function PinnedReorderGrid({
  pets,
  petStateCount,
  hideAuthor,
}: PinnedReorderGridProps) {
  const t = useTranslations("pinnedReorder");
  const orderRef = useRef<PetWithMetrics[]>(pets);
  const [order, setOrder] = useState<PetWithMetrics[]>(pets);
  const [savedSlugs, setSavedSlugs] = useState<string[]>(
    pets.map((pet) => pet.slug),
  );
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(() => {
    const slugs = pets.map((pet) => pet.slug);
    orderRef.current = pets;
    setOrder(pets);
    setSavedSlugs(slugs);
    setActiveDrag(null);
    setError(null);
    setSaveState("idle");
  }, [pets]);

  useEffect(() => {
    if (saveState !== "saved") return;

    const timer = window.setTimeout(() => {
      setSaveState((current) => (current === "saved" ? "idle" : current));
    }, 1800);

    return () => window.clearTimeout(timer);
  }, [saveState]);

  const isSaving = saveState === "saving";
  const oneOnly = order.length <= 1;
  const itemIds = useMemo(() => order.map((pet) => pet.slug), [order]);
  const activePet = activeDrag
    ? orderRef.current.find((pet) => pet.slug === activeDrag.slug)
    : null;

  function orderFromSlugs(slugs: string[]): PetWithMetrics[] {
    const bySlug = new Map(pets.map((pet) => [pet.slug, pet]));
    return slugs
      .map((slug) => bySlug.get(slug))
      .filter((pet): pet is PetWithMetrics => Boolean(pet));
  }

  function setNextOrder(next: PetWithMetrics[]) {
    orderRef.current = next;
    setOrder(next);
  }

  async function saveOrder(nextOrder: PetWithMetrics[]) {
    setSaveState("saving");
    setError(null);
    try {
      const slugs = nextOrder.map((pet) => pet.slug);
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ featuredPetSlugs: slugs }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `save failed (${res.status})`);
      }
      setSavedSlugs(slugs);
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      setError((err as Error).message);
    }
  }

  function restoreSavedOrder() {
    setNextOrder(orderFromSlugs(savedSlugs));
    setActiveDrag(null);
    setError(null);
    setSaveState("idle");
  }

  function retrySave() {
    if (isSaving) return;
    void saveOrder(orderRef.current);
  }

  function handleDragStart(event: DragStartEvent) {
    const slug = String(event.active.id);
    const rect = event.active.rect.current.initial;
    setError(null);
    setSaveState("idle");
    setActiveDrag({
      slug,
      width: rect?.width,
      height: rect?.height,
    });
  }

  function finishDrag() {
    setActiveDrag(null);
  }

  function handleDragCancel(_event: DragCancelEvent) {
    finishDrag();
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    finishDrag();
    if (!over || active.id === over.id) return;

    const current = orderRef.current;
    const from = current.findIndex((pet) => pet.slug === active.id);
    const to = current.findIndex((pet) => pet.slug === over.id);
    const next = movePinnedPets(current, from, to);
    if (next === current) return;

    setNextOrder(next);
    void saveOrder(next);
  }

  const statusLabel =
    saveState === "saving"
      ? "Saving..."
      : saveState === "saved"
        ? "Order updated"
        : saveState === "error"
          ? t("reorderLabel")
          : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[11px] tracking-[0.22em] text-brand uppercase">
          ★ Pinned
        </p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {statusLabel ? (
            <span
              className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[11px] font-medium ${
                saveState === "error"
                  ? "border-red-300 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
                  : "border-border-base bg-surface text-muted-2"
              }`}
            >
              {saveState === "saved" ? <Check className="size-3" /> : null}
              {statusLabel}
            </span>
          ) : null}
          <p className="font-mono text-[10px] tracking-[0.18em] text-muted-4 uppercase">
            {order.length} of {MAX_PINNED_PETS}
          </p>
        </div>
      </div>

      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          <p>{t("saveError", { error })}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={retrySave}
              disabled={isSaving}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-red-300/70 bg-white/70 px-2.5 font-medium transition hover:bg-white disabled:opacity-50 dark:border-red-800 dark:bg-red-950/50"
            >
              <RefreshCcw className="size-3" />
              Retry
            </button>
            <button
              type="button"
              onClick={restoreSavedOrder}
              disabled={isSaving}
              className="inline-flex h-7 items-center rounded-full border border-red-300/70 bg-white/70 px-2.5 font-medium transition hover:bg-white disabled:opacity-50 dark:border-red-800 dark:bg-red-950/50"
            >
              Restore saved order
            </button>
          </div>
        </div>
      ) : null}

      {!oneOnly ? (
        <p className="text-xs text-muted-3">
          Drag a pet by its handle to reorder. Changes save when you drop.
        </p>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragCancel={handleDragCancel}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={itemIds} strategy={rectSortingStrategy}>
          <div
            className={
              oneOnly
                ? "relative"
                : "grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-6"
            }
          >
            {order.map((pet, index) => (
              <SortablePinnedPet
                key={pet.slug}
                pet={pet}
                index={index}
                isSaving={isSaving}
                oneOnly={oneOnly}
                petStateCount={petStateCount}
                pinnedCount={order.length}
                hideAuthor={hideAuthor}
              />
            ))}
          </div>
        </SortableContext>

        <DragOverlay dropAnimation={null}>
          {activePet ? (
            <div
              className="opacity-95 shadow-2xl shadow-blue-950/20"
              style={{
                width: activeDrag?.width,
                height: activeDrag?.height,
              }}
            >
              <PetCard
                pet={activePet}
                index={orderRef.current.findIndex(
                  (pet) => pet.slug === activePet.slug,
                )}
                stateCount={petStateCount}
                hideAuthor={hideAuthor}
                actionMode="profilePinHover"
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

type SortablePinnedPetProps = {
  pet: PetWithMetrics;
  index: number;
  isSaving: boolean;
  oneOnly: boolean;
  petStateCount: number;
  pinnedCount: number;
  hideAuthor?: boolean;
};

function SortablePinnedPet({
  pet,
  index,
  isSaving,
  oneOnly,
  petStateCount,
  pinnedCount,
  hideAuthor,
}: SortablePinnedPetProps) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: pet.slug,
    disabled: oneOnly || isSaving,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative h-full ${
        isDragging
          ? "rounded-3xl bg-sky-100/80 ring-2 ring-sky-200 dark:bg-sky-950/30 dark:ring-sky-800/60"
          : ""
      }`}
    >
      <div className={isDragging ? "opacity-0" : ""}>
        <PetCard
          pet={pet}
          index={index}
          stateCount={petStateCount}
          hideAuthor={hideAuthor}
          pinState={{ isPinned: true, pinnedCount, maxPins: MAX_PINNED_PETS }}
          actionMode="profilePinHover"
        />
      </div>

      {!oneOnly && !isDragging ? (
        <button
          ref={setActivatorNodeRef}
          type="button"
          disabled={isSaving}
          aria-label={`Drag ${pet.displayName} to reorder`}
          className="absolute top-6 right-4 z-40 grid size-8 -translate-y-1/2 cursor-grab touch-none place-items-center rounded-md text-muted-3 transition hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
