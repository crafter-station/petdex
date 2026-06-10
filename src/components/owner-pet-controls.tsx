"use client";

import { useEffect, useState } from "react";

import { useAuthIntent } from "@/components/auth-intent";

type OwnerPetControlsProps = {
  slug: string;
  currentDisplayName: string;
  currentDescription: string;
};

type OwnerPetControlsComponent = React.ComponentType<OwnerPetControlsProps>;

export function OwnerPetControls(props: OwnerPetControlsProps) {
  const { authActive } = useAuthIntent();
  const [AuthOwnerPetControls, setAuthOwnerPetControls] =
    useState<OwnerPetControlsComponent | null>(null);

  useEffect(() => {
    if (!authActive || AuthOwnerPetControls) return;
    let cancelled = false;
    void import("@/components/owner-pet-controls-auth").then((mod) => {
      if (!cancelled) setAuthOwnerPetControls(() => mod.OwnerPetControls);
    });
    return () => {
      cancelled = true;
    };
  }, [AuthOwnerPetControls, authActive]);

  return authActive && AuthOwnerPetControls ? (
    <AuthOwnerPetControls {...props} />
  ) : null;
}
