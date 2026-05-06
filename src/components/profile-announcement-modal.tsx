"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useUser } from "@clerk/nextjs";
import { ArrowRight, Sparkles, X } from "lucide-react";

const STORAGE_KEY = "petdex_announce_profile_v1";

// One-time modal announcing /u/[handle] public profiles.
//
// Only fires for signed-in users (anonymous viewers don't have a handle
// to advertise yet). Stacked behind the onboarding tour and the vibe
// search announcement: we wait until both prior modals have been
// dismissed so first-time visitors see them in order.
export function ProfileAnnouncementModal() {
  const { user, isLoaded, isSignedIn } = useUser();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isLoaded || !isSignedIn || !user) return;
    if (window.localStorage.getItem(STORAGE_KEY) === "1") return;
    if (window.localStorage.getItem("petdex_tour_seen_v1") !== "1") return;
    if (window.localStorage.getItem("petdex_announce_vibe_search_v1") !== "1")
      return;

    const t = window.setTimeout(() => {
      setOpen(true);
    }, 1500);
    return () => window.clearTimeout(t);
  }, [isLoaded, isSignedIn, user]);

  // Engagement is captured downstream via the cta_view click event;
  // the announcement_shown / announcement_closed pair was pure noise.
  function close(
    _reason: "dismiss" | "cta_view" | "cta_customize" = "dismiss",
  ) {
    setClosing(true);
    window.setTimeout(() => {
      setOpen(false);
      window.localStorage.setItem(STORAGE_KEY, "1");
    }, 220);
  }

  if (!open || !user) return null;

  const handle =
    (user.username ?? "").toLowerCase() || user.id.slice(-8).toLowerCase();
  const displayName =
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    user.username ||
    handle;

  return (
    <div
      className={`fixed inset-0 z-[70] flex items-end justify-center px-4 pb-4 sm:items-center sm:p-6 ${
        closing ? "pointer-events-none" : ""
      }`}
      role="dialog"
      aria-modal="true"
      aria-label="Petdex profiles announcement"
    >
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => close("dismiss")}
        className={`absolute inset-0 bg-slate-900/30 backdrop-blur-sm transition-opacity duration-200 ${
          closing ? "opacity-0" : "opacity-100"
        }`}
      />

      <div
        className={`relative w-full max-w-md overflow-hidden rounded-3xl border border-border-base bg-white shadow-[0_30px_80px_-20px_rgba(56,71,245,0.45)] transition-all duration-200 ${
          closing ? "translate-y-2 opacity-0" : "translate-y-0 opacity-100"
        } dark:bg-stone-900`}
      >
        {/* Hero — preview of the user's actual profile URL with their avatar. */}
        <div className="relative aspect-[3/2] w-full overflow-hidden bg-gradient-to-br from-brand-tint via-white to-[#dbe2ff]">
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6">
            {user.imageUrl ? (
              // biome-ignore lint/performance/noImgElement: Clerk avatar
              <img
                src={user.imageUrl}
                alt=""
                className="size-20 rounded-3xl object-cover ring-2 ring-white shadow-[0_18px_45px_-22px_rgba(82,102,234,0.5)]"
              />
            ) : (
              <div className="grid size-20 place-items-center rounded-3xl bg-surface font-mono text-2xl font-semibold text-muted-2 ring-2 ring-white shadow-[0_18px_45px_-22px_rgba(82,102,234,0.5)]">
                {displayName.slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="rounded-2xl border border-border-base bg-surface/90 px-4 py-2 backdrop-blur">
              <p className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
                Live at
              </p>
              <p className="font-mono text-sm tracking-[0.04em] text-stone-900 dark:text-stone-100">
                petdex.crafter.run/u/{handle}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => close("dismiss")}
            aria-label="Close"
            className="absolute top-3 right-3 grid size-8 place-items-center rounded-full bg-surface/90 text-muted-2 shadow-sm transition hover:bg-white hover:text-foreground dark:hover:bg-stone-800"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-4 p-6">
          <div className="flex items-center gap-2">
            <span className="grid size-6 place-items-center rounded-full bg-brand text-white">
              <Sparkles className="size-3" />
            </span>
            <p className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
              New · Public profiles
            </p>
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            You have your own profile now
          </h2>
          <p className="text-sm leading-6 text-muted-2">
            Every Petdex creator gets a public page with all their approved
            pets, an avatar, links, and an optional pinned favorite. Drop the
            URL in your bio.
          </p>
          <p className="text-sm leading-6 text-muted-2">
            Add a bio, pin a pet, and review your submissions, all from your
            profile page.
          </p>

          <div className="flex items-center gap-2 pt-1">
            <Link
              href={`/u/${handle}`}
              onClick={() => close("cta_view")}
              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-inverse px-5 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover"
            >
              View my profile
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
