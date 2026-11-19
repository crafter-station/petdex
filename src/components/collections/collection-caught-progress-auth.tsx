"use client";

import { useMemo } from "react";

import { useTranslations } from "next-intl";

import { useHeaderState } from "@/components/layout/header-state-provider";

type Props = {
  petSlugs: string[];
};

export function CollectionCaughtProgress({ petSlugs }: Props) {
  const t = useTranslations("collectionDetail");
  const { state } = useHeaderState();
  const caughtCount = useMemo(() => {
    const caught = new Set(state.caught);
    return petSlugs.filter((slug) => caught.has(slug)).length;
  }, [petSlugs, state.caught]);

  if (!state.signedIn) return null;

  return (
    <span>{t("caught", { caught: caughtCount, total: petSlugs.length })}</span>
  );
}
