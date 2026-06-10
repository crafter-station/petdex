"use client";

import { useEffect, useState } from "react";

import { ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";

import { useAuthIntent } from "@/components/auth-intent";

type ClaimCTAProps = {
  petName: string;
  authorLabel: string;
  githubUrl: string | null;
};

type ClaimCTAComponent = React.ComponentType<ClaimCTAProps>;

export function ClaimCTA(props: ClaimCTAProps) {
  const { authActive, requestAuth } = useAuthIntent();
  const [AuthClaimCTA, setAuthClaimCTA] = useState<ClaimCTAComponent | null>(
    null,
  );
  const t = useTranslations("claim");

  useEffect(() => {
    if (!authActive || AuthClaimCTA) return;
    let cancelled = false;
    void import("@/components/claim-cta-auth").then((mod) => {
      if (!cancelled) setAuthClaimCTA(() => mod.ClaimCTA);
    });
    return () => {
      cancelled = true;
    };
  }, [AuthClaimCTA, authActive]);

  if (authActive && AuthClaimCTA) return <AuthClaimCTA {...props} />;

  const inner = (
    <span className="inline-flex h-10 items-center gap-1.5 rounded-full bg-inverse px-4 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover">
      {t("cta")}
      <ArrowRight className="size-4" />
    </span>
  );

  return (
    <aside className="mt-3 flex flex-wrap items-center gap-3 rounded-2xl border border-chip-warning-fg/30 bg-chip-warning-bg p-4 text-sm text-chip-warning-fg">
      <span className="flex-1 leading-6">
        {t.rich("body", {
          author: props.authorLabel,
          petName: props.petName,
          strong: (chunks) => (
            <strong className="font-semibold">{chunks}</strong>
          ),
        })}
      </span>
      <button type="button" onClick={requestAuth} className="inline-flex">
        {inner}
      </button>
    </aside>
  );
}
