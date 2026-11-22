"use client";

import { useEffect, useState } from "react";

import { Heart } from "lucide-react";
import { useLocale } from "next-intl";

import { formatLocalizedNumber } from "@/lib/format-number";
import { loadPetMetrics } from "@/lib/pet-metrics-client";

import { useAuthIntent } from "@/components/auth/auth-intent";
import { Button } from "@/components/ui/button";

type LikeButtonProps = {
  slug: string;
};

type LikeButtonComponent = React.ComponentType<LikeButtonProps>;

export function LikeButton({ slug }: LikeButtonProps) {
  const { authActive, requestAuth } = useAuthIntent();
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [AuthLikeButton, setAuthLikeButton] =
    useState<LikeButtonComponent | null>(null);
  const locale = useLocale();

  useEffect(() => {
    if (!authActive || AuthLikeButton) return;
    let cancelled = false;
    void import("@/components/pets/like-button-auth").then((mod) => {
      if (!cancelled) setAuthLikeButton(() => mod.LikeButton);
    });
    return () => {
      cancelled = true;
    };
  }, [AuthLikeButton, authActive]);

  useEffect(() => {
    if (authActive) return;
    let active = true;
    setLoading(true);
    void loadPetMetrics(slug)
      .then((data) => {
        if (!active) return;
        setCount(typeof data?.likeCount === "number" ? data.likeCount : 0);
      })
      .catch(() => {
        if (active) setCount(0);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authActive, slug]);

  if (authActive && AuthLikeButton) return <AuthLikeButton slug={slug} />;

  return (
    <Button
      variant="pearl"
      size="lg"
      onClick={requestAuth}
      aria-busy={loading || undefined}
      className="gap-1.5 rounded-xl px-3.5 text-[13px] font-medium disabled:opacity-60"
    >
      <Heart className="size-4 transition" />
      <span className="font-hardware text-[11px] tracking-[0.08em]">
        {count === null ? "-" : formatLocalizedNumber(count, locale)}
      </span>
    </Button>
  );
}
