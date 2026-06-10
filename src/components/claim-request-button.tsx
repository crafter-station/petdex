"use client";

import { useEffect, useState } from "react";

import { HandHeart } from "lucide-react";

import { useAuthIntent } from "@/components/auth-intent";

type ClaimRequestButtonProps = {
  requestId: string;
  requestQuery: string;
};

type ClaimRequestButtonComponent = React.ComponentType<ClaimRequestButtonProps>;

export function ClaimRequestButton(props: ClaimRequestButtonProps) {
  const { authActive, requestAuth } = useAuthIntent();
  const [AuthClaimRequestButton, setAuthClaimRequestButton] =
    useState<ClaimRequestButtonComponent | null>(null);

  useEffect(() => {
    if (!authActive || AuthClaimRequestButton) return;
    let cancelled = false;
    void import("@/components/claim-request-button-auth").then((mod) => {
      if (!cancelled) setAuthClaimRequestButton(() => mod.ClaimRequestButton);
    });
    return () => {
      cancelled = true;
    };
  }, [AuthClaimRequestButton, authActive]);

  if (authActive && AuthClaimRequestButton) {
    return <AuthClaimRequestButton {...props} />;
  }

  return (
    <button
      type="button"
      onClick={requestAuth}
      className="inline-flex items-center gap-1.5 rounded-full border border-border-base bg-surface-muted px-2.5 py-1 font-mono text-[11px] tracking-[0.04em] text-muted-2 transition hover:border-brand/30 hover:bg-brand-tint hover:text-brand-deep dark:hover:bg-brand-tint-dark"
    >
      <HandHeart className="size-3" />I have a pet for this
    </button>
  );
}
