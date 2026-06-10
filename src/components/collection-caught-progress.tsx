"use client";

import { useEffect, useState } from "react";

import { useAuthIntent } from "@/components/auth-intent";

type Props = {
  petSlugs: string[];
};

type CollectionCaughtProgressComponent = React.ComponentType<Props>;

export function CollectionCaughtProgress(props: Props) {
  const { authActive } = useAuthIntent();
  const [AuthCollectionCaughtProgress, setAuthCollectionCaughtProgress] =
    useState<CollectionCaughtProgressComponent | null>(null);

  useEffect(() => {
    if (!authActive || AuthCollectionCaughtProgress) return;
    let cancelled = false;
    void import("@/components/collection-caught-progress-auth").then((mod) => {
      if (!cancelled) {
        setAuthCollectionCaughtProgress(() => mod.CollectionCaughtProgress);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [AuthCollectionCaughtProgress, authActive]);

  return authActive && AuthCollectionCaughtProgress ? (
    <AuthCollectionCaughtProgress {...props} />
  ) : null;
}
