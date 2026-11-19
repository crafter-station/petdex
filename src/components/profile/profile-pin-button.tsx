"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Pin, PinOff } from "lucide-react";
import { useTranslations } from "next-intl";

// One-click pin/unpin for an approved pet on the owner's /u/[handle]
// page. Calls /api/profile with a pin or unpin action so the server
// reads the current set, applies the diff, and re-validates.
export function ProfilePinButton({
  slug,
  isPinned,
  pinnedCount,
  maxPins,
  appearance = "default",
  onOptimisticChange,
  disabled,
  disabledTitle,
}: {
  slug: string;
  isPinned: boolean;
  pinnedCount: number;
  maxPins: number;
  appearance?: "default" | "subtle";
  onOptimisticChange?: (isPinned: boolean) => void;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  const router = useRouter();
  const t = useTranslations("profile.pin");
  const [, startTransition] = useTransition();
  const [optimisticPinned, setOptimisticPinned] = useState(isPinned);
  const pinRequestSeq = useRef(0);

  useEffect(() => {
    setOptimisticPinned(isPinned);
  }, [isPinned]);

  const optimisticPinnedCount =
    pinnedCount +
    (optimisticPinned === isPinned ? 0 : optimisticPinned ? 1 : -1);
  const capReached = !optimisticPinned && optimisticPinnedCount >= maxPins;

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    if (capReached) {
      alert(t("capAlert", { max: maxPins }));
      return;
    }
    const previousPinned = optimisticPinned;
    const nextPinned = !previousPinned;
    const seq = pinRequestSeq.current + 1;
    pinRequestSeq.current = seq;
    setOptimisticPinned(nextPinned);
    onOptimisticChange?.(nextPinned);
    try {
      const body = nextPinned ? { pin: { slug } } : { unpin: { slug } };
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        if (pinRequestSeq.current === seq) {
          setOptimisticPinned(previousPinned);
          onOptimisticChange?.(previousPinned);
        }
        const j = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (j?.error === "pin_cap_reached") {
          alert(t("capAlert", { max: maxPins }));
        } else {
          alert(t("failed", { code: j?.error ?? `http_${res.status}` }));
        }
        return;
      }
      if (pinRequestSeq.current === seq) {
        startTransition(() => router.refresh());
      }
    } catch {
      if (pinRequestSeq.current === seq) {
        setOptimisticPinned(previousPinned);
        onOptimisticChange?.(previousPinned);
      }
      alert(t("networkError"));
    }
  }

  const title = disabled
    ? (disabledTitle ?? t("unavailable"))
    : optimisticPinned
      ? t("unpin")
      : capReached
        ? t("capReached", { max: maxPins })
        : t("pin");

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled || capReached}
      title={title}
      aria-label={title}
      style={{ zIndex: 30 }}
      className={`inline-flex size-8 items-center justify-center rounded-full border backdrop-blur transition disabled:cursor-not-allowed disabled:opacity-60 ${
        appearance === "subtle"
          ? optimisticPinned
            ? "border-border-base bg-surface/90 text-brand hover:border-brand/30 hover:bg-brand-tint"
            : "border-black/10 bg-surface/90 text-muted-2 hover:border-border-strong hover:text-black"
          : optimisticPinned
            ? "border-brand/40 bg-brand text-on-inverse hover:bg-brand-deep"
            : "border-black/10 bg-surface/90 text-muted-2 hover:border-border-strong hover:text-black"
      }`}
    >
      {optimisticPinned ? (
        <PinOff className="size-3.5" />
      ) : (
        <Pin className="size-3.5" />
      )}
    </button>
  );
}
