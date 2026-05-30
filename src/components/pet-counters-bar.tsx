"use client";

import { useEffect, useState } from "react";

import { useLocale } from "next-intl";

import { formatLocalizedNumber } from "@/lib/format-number";

type PetCountersBarProps = {
  slug: string;
};

type CountersResponse = {
  installCount: number;
  zipDownloadCount: number;
};

export function PetCountersBar({ slug }: PetCountersBarProps) {
  const locale = useLocale();
  const [counts, setCounts] = useState<CountersResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/pets/${slug}/metrics`, { signal: controller.signal })
      .then((res) =>
        res.ok ? (res.json() as Promise<CountersResponse>) : null,
      )
      .then((data) => {
        if (!data) return;
        setCounts({
          installCount: data.installCount,
          zipDownloadCount: data.zipDownloadCount,
        });
      })
      .catch(() => {
        /* network/abort — keep skeleton */
      });
    return () => controller.abort();
  }, [slug]);

  return (
    <span
      className="font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase"
      aria-live="polite"
    >
      {counts ? (
        <>
          {formatLocalizedNumber(counts.installCount, locale)} installs
          {" · "}
          {formatLocalizedNumber(counts.zipDownloadCount, locale)} downloads
        </>
      ) : (
        <span className="opacity-50">— installs · — downloads</span>
      )}
    </span>
  );
}
