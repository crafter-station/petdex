"use client";

import { useEffect, useState } from "react";

import { useLocale, useTranslations } from "next-intl";

import { formatLocalizedNumber } from "@/lib/format-number";
import { loadPetMetrics } from "@/lib/pet-metrics-client";

type PetCountersBarProps = {
  slug: string;
};

type CountersResponse = {
  installCount: number;
  zipDownloadCount: number;
};

export function PetCountersBar({ slug }: PetCountersBarProps) {
  const locale = useLocale();
  const t = useTranslations("pet.counters");
  const [counts, setCounts] = useState<CountersResponse | null>(null);

  useEffect(() => {
    let active = true;
    void loadPetMetrics(slug)
      .then((data) => {
        if (!active) return;
        if (!data) return;
        setCounts({
          installCount: data.installCount,
          zipDownloadCount: data.zipDownloadCount,
        });
      })
      .catch(() => {
        /* network/abort — keep skeleton */
      });
    return () => {
      active = false;
    };
  }, [slug]);

  return (
    <span
      className="font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase"
      aria-live="polite"
    >
      {counts ? (
        <>
          {t("installs", {
            count: formatLocalizedNumber(counts.installCount, locale),
          })}
          {" · "}
          {t("downloads", {
            count: formatLocalizedNumber(counts.zipDownloadCount, locale),
          })}
        </>
      ) : (
        <span className="opacity-50">{t("skeleton")}</span>
      )}
    </span>
  );
}
