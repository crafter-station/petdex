"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Pin, PinOff } from "lucide-react";

import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";

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
      alert(`You can pin up to ${maxPins} pets. Unpin one first.`);
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
          alert(`You can pin up to ${maxPins} pets. Unpin one first.`);
        } else {
          alert(`Failed: ${j?.error ?? res.statusText}`);
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
      alert("Failed: network error");
    }
  }

  const title = disabled
    ? (disabledTitle ?? "Pin controls are temporarily unavailable")
    : optimisticPinned
      ? "Unpin from profile"
      : capReached
        ? `Pin cap reached (${maxPins})`
        : "Pin to profile";

  return (
    <Button
      type="button"
      variant={optimisticPinned && appearance !== "subtle" ? "cobalt" : "pearl"}
      size="icon"
      onClick={toggle}
      disabled={disabled || capReached}
      title={title}
      aria-label={title}
      style={{ zIndex: 30 }}
      className={cn(
        appearance === "subtle" &&
          optimisticPinned &&
          "border-[#3B59F2]/40 text-[#2943CC] dark:text-[#8CA3FF]",
      )}
    >
      {optimisticPinned ? (
        <PinOff className="size-3.5" />
      ) : (
        <Pin className="size-3.5" />
      )}
    </Button>
  );
}
