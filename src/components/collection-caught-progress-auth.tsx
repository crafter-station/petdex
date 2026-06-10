"use client";

import { useMemo } from "react";

import { useHeaderState } from "@/components/header-state-provider";

type Props = {
  petSlugs: string[];
};

export function CollectionCaughtProgress({ petSlugs }: Props) {
  const { state } = useHeaderState();
  const caughtCount = useMemo(() => {
    const caught = new Set(state.caught);
    return petSlugs.filter((slug) => caught.has(slug)).length;
  }, [petSlugs, state.caught]);

  if (!state.signedIn) return null;

  return (
    <span>
      caught {caughtCount}/{petSlugs.length}
    </span>
  );
}
