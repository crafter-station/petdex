"use client";

// Owner-only reorderable pinned-pets grid for /u/<handle>. The pinned
// set is capped at 6, so pointer events give us desktop + touch drag
// without adding a drag-and-drop dependency.

import { useEffect, useRef, useState } from "react";

import {
  ArrowLeft,
  ArrowRight,
  Check,
  GripVertical,
  RefreshCcw,
} from "lucide-react";

import type { PetWithMetrics } from "@/lib/pets";
import { MAX_PINNED_PETS } from "@/lib/profiles";

import { PetCard } from "@/components/pet-gallery";
import { ProfilePinButton } from "@/components/profile-pin-button";

type PinnedReorderGridProps = {
  pets: PetWithMetrics[];
  petStateCount: number;
};

type DragState = {
  slug: string;
  fromIndex: number;
  targetIndex: number;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
};

type SaveState = "idle" | "saving" | "saved" | "error";

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
}: PinnedReorderGridProps) {
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const [order, setOrder] = useState<PetWithMetrics[]>(pets);
  const [savedSlugs, setSavedSlugs] = useState<string[]>(
    pets.map((pet) => pet.slug),
  );
  const [editing, setEditing] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  useEffect(() => {
    const slugs = pets.map((pet) => pet.slug);
    setOrder(pets);
    setSavedSlugs(slugs);
    setDrag(null);
    setError(null);
    setSaveState("idle");
  }, [pets]);

  const isSaving = saveState === "saving";
  const activeSlug = drag?.slug ?? null;

  function setItemRef(slug: string) {
    return (node: HTMLDivElement | null) => {
      if (node) {
        itemRefs.current.set(slug, node);
      } else {
        itemRefs.current.delete(slug);
      }
    };
  }

  function orderFromSlugs(slugs: string[]): PetWithMetrics[] {
    const bySlug = new Map(pets.map((pet) => [pet.slug, pet]));
    return slugs
      .map((slug) => bySlug.get(slug))
      .filter((pet): pet is PetWithMetrics => Boolean(pet));
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
    setOrder(orderFromSlugs(savedSlugs));
    setDrag(null);
    setError(null);
    setSaveState("idle");
  }

  function startEditing() {
    setEditing(true);
    setError(null);
    setSaveState("idle");
  }

  function finishEditing() {
    if (isSaving || saveState === "error") return;
    setEditing(false);
    setDrag(null);
    setError(null);
    setSaveState("idle");
  }

  function retrySave() {
    if (isSaving) return;
    void saveOrder(order);
  }

  function moveAndSave(from: number, to: number) {
    if (isSaving) return;
    const next = movePinnedPets(order, from, to);
    if (next === order) return;
    setOrder(next);
    void saveOrder(next);
  }

  function targetIndexForPoint(clientX: number, clientY: number): number {
    let targetIndex = drag?.targetIndex ?? 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [index, pet] of order.entries()) {
      if (pet.slug === drag?.slug) continue;
      const rect = itemRefs.current.get(pet.slug)?.getBoundingClientRect();
      if (!rect) continue;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const distance = (clientX - centerX) ** 2 + (clientY - centerY) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        targetIndex = index;
      }
    }
    return targetIndex;
  }

  function onHandlePointerDown(
    event: React.PointerEvent<HTMLButtonElement>,
    slug: string,
    index: number,
  ) {
    if (!editing || isSaving) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setError(null);
    setSaveState("idle");
    setDrag({
      slug,
      fromIndex: index,
      targetIndex: index,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function onHandlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const targetIndex = targetIndexForPoint(event.clientX, event.clientY);
    setDrag((current) =>
      current
        ? {
            ...current,
            targetIndex,
            x: event.clientX,
            y: event.clientY,
          }
        : current,
    );
  }

  function onHandlePointerUp(event: React.PointerEvent<HTMLButtonElement>) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const { fromIndex, targetIndex } = drag;
    setDrag(null);
    if (fromIndex !== targetIndex) {
      const next = movePinnedPets(order, fromIndex, targetIndex);
      setOrder(next);
      void saveOrder(next);
    }
  }

  function onHandlePointerCancel(event: React.PointerEvent<HTMLButtonElement>) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    setDrag(null);
  }

  const oneOnly = order.length <= 1;
  const statusLabel =
    saveState === "saving"
      ? "Saving..."
      : saveState === "saved"
        ? "Order updated"
        : saveState === "error"
          ? "Could not save order"
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
          {!editing ? (
            order.length >= 2 ? (
              <button
                type="button"
                onClick={startEditing}
                className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border-base bg-surface px-3 text-[11px] font-medium text-muted-2 transition hover:border-border-strong hover:text-foreground"
              >
                <GripVertical className="size-3" />
                Reorder
              </button>
            ) : null
          ) : (
            <button
              type="button"
              onClick={finishEditing}
              disabled={isSaving || saveState === "error"}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-inverse px-3 text-[11px] font-medium text-on-inverse transition hover:bg-inverse-hover disabled:opacity-50"
            >
              <Check className="size-3" />
              Done
            </button>
          )}
        </div>
      </div>

      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
          <p>Could not save order: {error}</p>
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

      {editing ? (
        <p className="text-xs text-muted-3">
          Drag a pet by its handle to reorder. Drops are saved automatically.
        </p>
      ) : null}

      <div
        className={
          oneOnly
            ? "relative"
            : "grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 lg:grid-cols-6"
        }
      >
        {order.map((pet, index) => {
          const isActive = activeSlug === pet.slug;
          const isTarget =
            editing &&
            drag?.targetIndex === index &&
            drag.fromIndex !== index &&
            activeSlug !== pet.slug;
          const translate =
            isActive && drag
              ? {
                  transform: `translate3d(${drag.x - drag.startX}px, ${
                    drag.y - drag.startY
                  }px, 0) scale(1.03)`,
                }
              : undefined;
          return (
            <div
              key={pet.slug}
              ref={setItemRef(pet.slug)}
              style={translate}
              className={`relative h-full transition ${
                isActive
                  ? "z-30 cursor-grabbing opacity-95 shadow-2xl shadow-blue-950/20"
                  : ""
              } ${
                isTarget
                  ? "rounded-3xl ring-2 ring-brand ring-offset-2 ring-offset-background after:absolute after:inset-0 after:rounded-3xl after:border-2 after:border-dashed after:border-brand/70 after:bg-brand/5"
                  : ""
              }`}
            >
              <PetCard pet={pet} index={index} stateCount={petStateCount} />

              {editing ? (
                <>
                  <button
                    type="button"
                    onPointerDown={(event) =>
                      onHandlePointerDown(event, pet.slug, index)
                    }
                    onPointerMove={onHandlePointerMove}
                    onPointerUp={onHandlePointerUp}
                    onPointerCancel={onHandlePointerCancel}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    disabled={isSaving}
                    aria-label={`Drag ${pet.displayName} to reorder`}
                    className="absolute top-3 left-3 z-40 grid size-8 touch-none place-items-center rounded-full bg-surface/95 text-muted-2 shadow-sm ring-1 ring-black/5 transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:ring-white/10"
                  >
                    <GripVertical className="size-3.5" />
                  </button>
                  <div className="absolute bottom-3 left-3 z-40 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveAndSave(index, index - 1)}
                      disabled={index === 0 || isSaving}
                      aria-label={`Move ${pet.displayName} left`}
                      className="grid size-7 place-items-center rounded-full bg-surface/95 text-muted-2 shadow-sm ring-1 ring-black/5 transition hover:text-foreground disabled:opacity-30 dark:ring-white/10"
                    >
                      <ArrowLeft className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveAndSave(index, index + 1)}
                      disabled={index === order.length - 1 || isSaving}
                      aria-label={`Move ${pet.displayName} right`}
                      className="grid size-7 place-items-center rounded-full bg-surface/95 text-muted-2 shadow-sm ring-1 ring-black/5 transition hover:text-foreground disabled:opacity-30 dark:ring-white/10"
                    >
                      <ArrowRight className="size-3.5" />
                    </button>
                  </div>
                </>
              ) : (
                <div className="absolute top-3 right-14">
                  <ProfilePinButton
                    slug={pet.slug}
                    isPinned
                    pinnedCount={order.length}
                    maxPins={MAX_PINNED_PETS}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
