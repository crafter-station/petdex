"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { useAuth, useClerk } from "@clerk/nextjs";
import { track } from "@vercel/analytics";
import { Heart } from "lucide-react";
import { useLocale } from "next-intl";

import { formatLocalizedNumber } from "@/lib/format-number";

import { Button } from "@/components/ui/button";

type LikeButtonProps = {
  slug: string;
};

export function LikeButton({ slug }: LikeButtonProps) {
  const [count, setCount] = useState<number | null>(null);
  const [liked, setLiked] = useState(false);
  const [likeStateLoading, setLikeStateLoading] = useState(false);
  const [pending, start] = useTransition();
  const locale = useLocale();
  const { isLoaded, isSignedIn } = useAuth();
  const clerk = useClerk();
  const loadVersionRef = useRef(0);
  const mutationVersionRef = useRef(0);

  useEffect(() => {
    const loadVersion = loadVersionRef.current + 1;
    loadVersionRef.current = loadVersion;

    if (!isLoaded) {
      setLikeStateLoading(true);
      return;
    }

    const mutationVersion = mutationVersionRef.current;
    const controller = new AbortController();
    setLikeStateLoading(true);

    // Signed-in users hit /like (returns authoritative count + their
    // liked state). Anon visitors hit /metrics (CDN-cached, just the
    // count). Both endpoints are safe to ignore on abort/error — the
    // button stays in its skeleton state.
    const url = isSignedIn
      ? `/api/pets/${slug}/like`
      : `/api/pets/${slug}/metrics`;

    void fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: { liked?: boolean; count?: number; likeCount?: number } | null,
        ) => {
          if (!data) return;
          if (loadVersionRef.current !== loadVersion) return;
          if (mutationVersionRef.current !== mutationVersion) return;
          if (isSignedIn) {
            setLiked(Boolean(data.liked));
            setCount(typeof data.count === "number" ? data.count : 0);
          } else {
            setLiked(false);
            setCount(typeof data.likeCount === "number" ? data.likeCount : 0);
          }
        },
      )
      .catch((error: unknown) => {
        if (loadVersionRef.current !== loadVersion) return;
        if ((error as Error).name !== "AbortError") {
          setLiked(false);
        }
      })
      .finally(() => {
        if (loadVersionRef.current === loadVersion) {
          setLikeStateLoading(false);
        }
      });

    return () => controller.abort();
  }, [isLoaded, isSignedIn, slug]);

  function handleClick() {
    if (!isLoaded || !isSignedIn) {
      clerk.openSignIn({});
      return;
    }
    if (pending || likeStateLoading) return;

    const nextLiked = !liked;
    const mutationVersion = mutationVersionRef.current + 1;
    mutationVersionRef.current = mutationVersion;
    setLiked(nextLiked);
    setCount((c) => Math.max(0, (c ?? 0) + (nextLiked ? 1 : -1)));

    start(async () => {
      try {
        const res = await fetch(`/api/pets/${slug}/like`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ liked: nextLiked }),
        });
        if (!res.ok) throw new Error("like failed");
        const data = (await res.json()) as { liked: boolean; count: number };
        if (mutationVersionRef.current !== mutationVersion) return;
        setLiked(data.liked);
        setCount(data.count);
        if (data.liked) {
          track("pet_liked", { slug });
        }
      } catch {
        if (mutationVersionRef.current !== mutationVersion) return;
        setLiked(!nextLiked);
        setCount((c) => Math.max(0, (c ?? 0) + (nextLiked ? -1 : 1)));
      }
    });
  }

  const disabled = pending || !isLoaded || likeStateLoading;

  return (
    <Button
      variant="outline"
      onClick={handleClick}
      aria-pressed={liked}
      aria-busy={disabled || undefined}
      disabled={disabled}
      className={`h-10 gap-2 rounded-full border px-4 text-sm font-medium transition disabled:opacity-60 ${
        liked
          ? "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
          : "border-black/10 bg-surface text-muted-2 hover:border-rose-300 hover:text-rose-700"
      } dark:bg-rose-950/40 dark:text-rose-300 dark:hover:border-rose-700`}
    >
      <Heart
        className={`size-4 transition ${liked ? "fill-rose-500 text-rose-500" : ""}`}
      />
      <span className="font-mono text-xs tracking-[0.08em]">
        {count === null ? "—" : formatLocalizedNumber(count, locale)}
      </span>
    </Button>
  );
}
