"use client";

import { useEffect, useState } from "react";

import { loadPetMetrics } from "@/lib/pet-metrics-client";
import { computeStatsFromSummary, type PetStats } from "@/lib/pet-stats";

import { PetRadar } from "@/components/pet-radar";

type PetRadarClientProps = {
  slug: string;
  importedAt: string;
  ariaLabel: string;
  labels: {
    vibrance: string;
    popularity: string;
    loved: string;
    freshness: string;
  };
};

const PLACEHOLDER_STATS: PetStats = {
  vibrance: 0,
  popularity: 0,
  loved: 0,
  freshness: 0,
};

export function PetRadarClient({
  slug,
  importedAt,
  ariaLabel,
  labels,
}: PetRadarClientProps) {
  const [stats, setStats] = useState<PetStats | null>(null);

  useEffect(() => {
    let active = true;
    void loadPetMetrics(slug)
      .then((data) => {
        if (!active) return;
        if (!data) return;
        setStats(
          computeStatsFromSummary(
            {
              importedAt,
              metrics: {
                installCount: data.installCount,
                likeCount: data.likeCount,
              },
            },
            data.summary,
          ),
        );
      })
      .catch(() => {
        /* keep placeholder */
      });
    return () => {
      active = false;
    };
  }, [slug, importedAt]);

  const display = stats ?? PLACEHOLDER_STATS;

  return (
    <PetRadar
      vibrance={display.vibrance}
      popularity={display.popularity}
      loved={display.loved}
      freshness={display.freshness}
      ariaLabel={ariaLabel}
      labels={labels}
    />
  );
}
