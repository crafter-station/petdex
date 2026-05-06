"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Loader2, Star } from "lucide-react";

type Props = {
  petId: string;
  initialFeatured: boolean;
  /** Display name only used in the aria-label so screen readers
   *  announce which pet is being featured. */
  petName: string;
  /** Visual variant. 'inline' is the compact pill used inside the
   *  Hidden Hits / Featured lists. 'solid' is the chunkier button
   *  used at the top of admin row cards. */
  variant?: "inline" | "solid";
};

export function AdminFeatureToggle({
  petId,
  initialFeatured,
  petName,
  variant = "inline",
}: Props) {
  const router = useRouter();
  const [featured, setFeatured] = useState(initialFeatured);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle() {
    if (pending) return;
    const next = !featured;
    // Optimistic flip — the API call is fast (single UPDATE) but
    // there's no reason to make the admin wait for the round-trip
    // before the chip flips.
    setFeatured(next);
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/admin/${petId}/feature`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ featured: next }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as {
            error?: string;
            message?: string;
          };
          setError(data.message ?? data.error ?? `failed (${res.status})`);
          // Roll back the optimistic flip so the UI reflects truth.
          setFeatured(!next);
          return;
        }
        // Soft refresh so insights queries (currently featured /
        // hidden hits) re-fetch and the lists update.
        router.refresh();
      } catch {
        setError("network_error");
        setFeatured(!next);
      }
    });
  }

  const baseClass =
    variant === "solid"
      ? "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition disabled:opacity-60"
      : "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] font-medium transition disabled:opacity-60";
  const stateClass = featured
    ? "border-brand bg-brand text-white hover:bg-brand-deep"
    : "border-border-base bg-surface text-muted-2 hover:border-border-strong hover:text-foreground";

  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        aria-pressed={featured}
        aria-label={featured ? `Unfeature ${petName}` : `Feature ${petName}`}
        className={`${baseClass} ${stateClass}`}
      >
        {pending ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <Star className={`size-3 ${featured ? "fill-current" : ""}`} />
        )}
        {featured ? "Featured" : "Feature"}
      </button>
      {error ? (
        <span
          role="alert"
          className="absolute top-full left-0 mt-1 whitespace-nowrap font-mono text-[10px] tracking-[0.12em] text-chip-danger-fg uppercase"
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}
