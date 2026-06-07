"use client";

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";

import { MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";

import type {
  PetActionMenuContentProps,
  PetActionMenuOwnerActions,
  PetActionMenuPet,
} from "@/components/pet-action-menu-content";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type {
  PetActionMenuOwnerActions,
  PetActionMenuPet,
} from "@/components/pet-action-menu-content";

type PetActionMenuVariant = "card" | "detail";

type Props = {
  pet: PetActionMenuPet;
  variant?: PetActionMenuVariant;
  ownerActions?: PetActionMenuOwnerActions;
};

function loadPetActionMenuContent() {
  return import("@/components/pet-action-menu-content");
}

function preloadPetActionMenuContent() {
  void loadPetActionMenuContent();
}

const PetActionMenuContent = dynamic<PetActionMenuContentProps>(
  () => loadPetActionMenuContent().then((mod) => mod.PetActionMenuContent),
  {
    loading: PetActionMenuContentLoading,
    ssr: false,
  },
);

export function PetActionMenu({ pet, variant = "card", ownerActions }: Props) {
  const t = useTranslations("petActions");
  const [open, setOpen] = useState(false);
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) preloadPetActionMenuContent();
    setOpen(nextOpen);
  }, []);
  const triggerClassName =
    variant === "detail"
      ? "inline-flex h-10 items-center justify-center gap-2 rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong"
      : "inline-flex size-8 items-center justify-center rounded-full border border-border-base bg-surface/90 text-muted-2 transition hover:border-border-strong hover:text-foreground";
  const menuAlign = variant === "detail" ? "start" : "end";

  return (
    <div
      style={open ? { zIndex: 60 } : undefined}
      className={variant === "card" ? "relative" : "relative inline-flex"}
    >
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={t("moreActions", { name: pet.displayName })}
              className={triggerClassName}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onFocus={preloadPetActionMenuContent}
              onPointerEnter={preloadPetActionMenuContent}
            />
          }
        >
          {variant === "detail" ? (
            <>
              <MoreHorizontal className="size-4" />
              {t("share")}
            </>
          ) : (
            <MoreHorizontal className="size-4" />
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align={menuAlign}
          sideOffset={6}
          className="w-60 overflow-hidden rounded-2xl border border-border-base bg-surface p-0 shadow-xl shadow-blue-950/15"
        >
          {open ? (
            <PetActionMenuContent
              onOpenChange={handleOpenChange}
              open={open}
              ownerActions={ownerActions}
              pet={pet}
            />
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function PetActionMenuContentLoading() {
  return (
    <div aria-hidden="true" className="space-y-1 p-2">
      <div className="mb-2 h-6 rounded-lg bg-surface-muted/80" />
      <div className="h-9 animate-pulse rounded-xl bg-surface-muted/70" />
      <div className="h-9 animate-pulse rounded-xl bg-surface-muted/70" />
      <div className="h-9 animate-pulse rounded-xl bg-surface-muted/70" />
    </div>
  );
}
