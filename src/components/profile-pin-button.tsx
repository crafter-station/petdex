"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Loader2, Pin, PinOff } from "lucide-react";

// One-click pin/unpin for an approved pet on the owner's /u/[handle]
// page. Calls /api/profile with a pin or unpin action so the server
// reads the current set, applies the diff, and re-validates.
export function ProfilePinButton({
  slug,
  isPinned,
  pinnedCount,
  maxPins,
  appearance = "default",
}: {
  slug: string;
  isPinned: boolean;
  pinnedCount: number;
  maxPins: number;
  appearance?: "default" | "subtle";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  const capReached = !isPinned && pinnedCount >= maxPins;

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (capReached) {
      alert(`You can pin up to ${maxPins} pets. Unpin one first.`);
      return;
    }
    setBusy(true);
    try {
      const body = isPinned ? { unpin: { slug } } : { pin: { slug } };
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
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
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  const title = isPinned
    ? "Unpin from profile"
    : capReached
      ? `Pin cap reached (${maxPins})`
      : "Pin to profile";

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy || capReached}
      title={title}
      aria-label={title}
      style={{ zIndex: 30 }}
      className={`inline-flex size-8 items-center justify-center rounded-full border backdrop-blur transition disabled:cursor-not-allowed disabled:opacity-60 ${
        appearance === "subtle"
          ? isPinned
            ? "border-border-base bg-surface/90 text-brand hover:border-brand/30 hover:bg-brand-tint"
            : "border-black/10 bg-surface/90 text-muted-2 hover:border-border-strong hover:text-black"
          : isPinned
            ? "border-brand/40 bg-brand text-white hover:bg-brand-deep"
            : "border-black/10 bg-surface/90 text-muted-2 hover:border-border-strong hover:text-black"
      }`}
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : isPinned ? (
        <PinOff className="size-3.5" />
      ) : (
        <Pin className="size-3.5" />
      )}
    </button>
  );
}
