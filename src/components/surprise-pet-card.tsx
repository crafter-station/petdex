"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { Dice5, ExternalLink, PackageOpen, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { withLocale } from "@/lib/locale-routing";
import { safeGetItem, safeSetItem } from "@/lib/utils";

import { PetSprite } from "@/components/pet-sprite";

import { hasLocale, type Locale } from "@/i18n/config";

type SurprisePet = {
  slug: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
  href: string;
  installHref: string;
};

const BASE_KEY = "petdex_surprise_pet_seen";
const THUMBNAIL_SPRITE_SCALE = 0.45;

export function SurprisePetCard() {
  const locale = useLocale();
  const currentLocale: Locale = hasLocale(locale) ? locale : "en";
  const t = useTranslations("home.surprise");
  const [pet, setPet] = useState<SurprisePet | null>(null);
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadPet = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/pets/random", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return;
      const next = (await response.json()) as SurprisePet;
      setPet(next);
      setVisible(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const today = new Date().toISOString().slice(0, 10);
    const key = `${BASE_KEY}_${today}`;
    if (safeGetItem(key) === "1") return;
    const timeout = window.setTimeout(() => {
      safeSetItem(key, "1");
      void loadPet();
    }, 2200);
    return () => window.clearTimeout(timeout);
  }, [loadPet]);

  if (!visible || pet === null) return null;

  const petHref = withLocale(pet.href, currentLocale);
  const installHref = withLocale(pet.installHref, currentLocale);

  return (
    <aside className="fixed bottom-4 left-4 z-40 w-[min(calc(100vw-2rem),360px)] rounded-3xl border border-border-base bg-surface/95 p-4 text-foreground shadow-[0_24px_70px_-32px_rgba(16,24,40,0.55)] backdrop-blur md:bottom-6 md:left-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
            {t("eyebrow")}
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight">
            {t("title")}
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setVisible(false)}
          aria-label={t("dismiss")}
          className="grid size-8 shrink-0 place-items-center rounded-full border border-border-base text-muted-2 transition hover:bg-surface-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="mt-4 flex gap-4">
        <Link
          href={petHref}
          className="grid size-24 shrink-0 place-items-center overflow-hidden rounded-2xl border border-border-base bg-surface-muted transition hover:-translate-y-0.5"
          aria-label={t("viewAria", { name: pet.displayName })}
        >
          <PetSprite
            src={pet.spritesheetPath}
            state="idle"
            scale={THUMBNAIL_SPRITE_SCALE}
            label={t("spriteAlt", { name: pet.displayName })}
          />
        </Link>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold">
            {pet.displayName}
          </h3>
          <p className="mt-1 line-clamp-3 text-sm leading-5 text-muted-2">
            {pet.description}
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <Link
          href={petHref}
          className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-inverse px-3 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover"
        >
          <ExternalLink className="size-3.5" />
          {t("view")}
        </Link>
        <Link
          href={installHref}
          className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full border border-border-base bg-surface px-3 text-xs font-medium text-foreground transition hover:bg-surface-muted"
        >
          <PackageOpen className="size-3.5" />
          {t("install")}
        </Link>
        <button
          type="button"
          onClick={() => void loadPet()}
          disabled={loading}
          className="inline-flex h-10 items-center justify-center gap-1.5 rounded-full border border-border-base bg-surface px-3 text-xs font-medium text-foreground transition hover:bg-surface-muted disabled:cursor-wait disabled:opacity-60"
        >
          <Dice5 className="size-3.5" />
          {t("shuffle")}
        </button>
      </div>
    </aside>
  );
}
