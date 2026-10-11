"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";

import { MoreHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";

import type {
  PetActionMenuContentProps,
  PetActionMenuOwnerActions,
  PetActionMenuPet,
} from "@/components/pets/pet-action-menu-content";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type {
  PetActionMenuOwnerActions,
  PetActionMenuPet,
} from "@/components/pets/pet-action-menu-content";

type PetActionMenuVariant = "card" | "detail";

type Props = {
  pet: PetActionMenuPet;
  variant?: PetActionMenuVariant;
  ownerActions?: PetActionMenuOwnerActions;
};

function loadPetActionMenuContent() {
  return import("@/components/pets/pet-action-menu-content");
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
  const popupRef = useRef<HTMLDivElement>(null);
  const [scrollDismissal, setScrollDismissal] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      setScrollDismissal(null);
      preloadPetActionMenuContent();
    }
    setOpen(nextOpen);
  }, []);

  useEffect(() => {
    if (!open) return;

    let closeTimeout: number | undefined;
    const handleScroll = (event: Event) => {
      // Long menus must remain usable when their own content scrolls.
      if (
        event.target instanceof Element &&
        event.target.closest('[data-slot="dropdown-menu-content"]')
      ) {
        return;
      }

      // Start once so continuous scrolling cannot postpone dismissal.
      if (closeTimeout === undefined) {
        const rect = popupRef.current?.parentElement?.getBoundingClientRect();
        if (rect) {
          // Pin the viewport coordinates while fading; the anchor keeps scrolling.
          setScrollDismissal({
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
          });
        }
        closeTimeout = window.setTimeout(() => setOpen(false), 200);
      }
    };

    // Capture also observes scrolls in nested page containers.
    window.addEventListener("scroll", handleScroll, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      window.clearTimeout(closeTimeout);
    };
  }, [open]);

  const triggerClassName =
    variant === "detail"
      ? "inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-border-base bg-surface/70 px-3.5 text-[13px] font-medium text-muted-2 backdrop-blur transition hover:bg-surface-muted hover:text-foreground"
      : "inline-flex size-8 items-center justify-center rounded-full border border-border-base bg-surface/70 text-muted-2 backdrop-blur transition hover:bg-surface-muted hover:text-foreground";
  const menuAlign = variant === "detail" ? "start" : "end";

  return (
    <div
      style={open ? { zIndex: 60 } : undefined}
      className={variant === "card" ? "relative" : "relative inline-flex"}
    >
      <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
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
          ref={popupRef}
          align={menuAlign}
          sideOffset={6}
          positionerProps={{
            positionMethod: "fixed",
            style: scrollDismissal
              ? {
                  ...scrollDismissal,
                  right: "auto",
                  bottom: "auto",
                  transform: "none",
                }
              : undefined,
          }}
          style={{
            opacity: scrollDismissal ? 0 : undefined,
            maxHeight: scrollDismissal?.height,
            pointerEvents: scrollDismissal ? "none" : undefined,
          }}
          className="w-64 p-0 transition-opacity duration-200 ease-out data-open:animate-none data-closed:animate-none data-starting-style:scale-100 data-ending-style:scale-100"
        >
          {/* The portal controls mounting so contents survive the exit transition. */}
          <PetActionMenuContent
            onOpenChange={handleOpenChange}
            open={open}
            ownerActions={ownerActions}
            pet={pet}
          />
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
