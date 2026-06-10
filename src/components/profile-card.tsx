"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { ExternalLink, Loader2, Pencil, Pin, Star, X } from "lucide-react";

import { MAX_PINNED_PETS } from "@/lib/profiles";

import { useHeaderState } from "@/components/header-state-provider";

type ApprovedPet = {
  slug: string;
  displayName: string;
  spritesheetUrl: string;
};

export type ProfileData = {
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  bio: string | null;
  featuredPetSlugs: string[];
  approvedPets: ApprovedPet[];
};

export function ProfileCard({ profile }: { profile: ProfileData }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [handle, setHandle] = useState(profile.handle);
  const [bio, setBio] = useState(profile.bio ?? "");
  const [pinned, setPinned] = useState<string[]>(profile.featuredPetSlugs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { refresh: refreshHeaderState } = useHeaderState();
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (!open) {
      setDisplayName(profile.displayName ?? "");
      setHandle(profile.handle);
      setBio(profile.bio ?? "");
      setPinned(profile.featuredPetSlugs);
      setError(null);
    }
  }, [
    open,
    profile.bio,
    profile.displayName,
    profile.featuredPetSlugs,
    profile.handle,
  ]);

  // Honor /my-pets#profile by auto-opening the editor.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash === "#profile") {
      setOpen(true);
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search,
      );
    }
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim() || null,
          handle: handle.trim() || null,
          bio: bio.trim() || null,
          featuredPetSlugs: pinned,
        }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(j?.error ?? res.statusText);
        return;
      }
      setOpen(false);
      await refreshHeaderState({ force: true });
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  function togglePin(slug: string) {
    setPinned((prev) => {
      if (prev.includes(slug)) return prev.filter((s) => s !== slug);
      if (prev.length >= MAX_PINNED_PETS) return prev;
      return [...prev, slug];
    });
  }

  const fallbackInitial = (profile.displayName ?? profile.handle ?? "?")
    .slice(0, 1)
    .toUpperCase();

  const pinnedDetails = profile.featuredPetSlugs
    .map((slug) => profile.approvedPets.find((p) => p.slug === slug))
    .filter((p): p is ApprovedPet => Boolean(p));

  return (
    <section
      id="profile"
      className="rounded-3xl border border-border-base bg-surface/76 p-5 backdrop-blur md:p-6"
    >
      <div className="flex flex-wrap items-center gap-4">
        {profile.avatarUrl ? (
          // biome-ignore lint/performance/noImgElement: Clerk avatar
          <img
            src={profile.avatarUrl}
            alt=""
            className="size-14 shrink-0 rounded-2xl ring-1 ring-black/10"
          />
        ) : (
          <div className="grid size-14 shrink-0 place-items-center rounded-2xl bg-surface-muted font-mono text-base font-semibold text-muted-2 ring-1 ring-black/10">
            {fallbackInitial}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] tracking-[0.22em] text-brand uppercase">
            Public profile
          </p>
          <p className="mt-1 truncate text-base font-medium text-foreground">
            {profile.displayName ?? `@${profile.handle}`}
          </p>
          <p className="font-mono text-[11px] tracking-[0.06em] text-muted-3">
            petdex.dev/u/{profile.handle}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href={`/u/${profile.handle}`}
            prefetch={false}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border-base bg-surface px-3 text-xs font-medium text-muted-2 transition hover:border-border-strong"
          >
            <ExternalLink className="size-3.5" />
            View public
          </Link>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-inverse px-3 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover"
          >
            <Pencil className="size-3.5" />
            Customize
          </button>
        </div>
      </div>

      {profile.bio || pinnedDetails.length > 0 ? (
        <div className="mt-4 grid gap-3 border-t border-black/[0.06] pt-4 md:grid-cols-2 dark:border-white/[0.06]">
          {profile.bio ? (
            <div>
              <p className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
                Bio
              </p>
              <p className="mt-1.5 text-sm leading-6 text-muted-2">
                {profile.bio}
              </p>
            </div>
          ) : null}
          {pinnedDetails.length > 0 ? (
            <div>
              <p className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
                Pinned ({pinnedDetails.length}/{MAX_PINNED_PETS})
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {pinnedDetails.map((p) => (
                  <span
                    key={p.slug}
                    className="inline-flex items-center gap-1 rounded-full bg-brand-tint px-2.5 py-1 text-xs font-medium text-brand dark:bg-brand-tint-dark"
                  >
                    <Star className="size-3" />
                    {p.displayName}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 rounded-2xl border border-dashed border-border-base bg-brand-tint/40 p-3 text-xs text-muted-2">
          Add a bio and pin up to {MAX_PINNED_PETS} pets so visitors land
          somewhere opinionated. Hit{" "}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="font-medium text-brand underline-offset-2 hover:underline"
          >
            Customize
          </button>{" "}
          to set it up.
        </div>
      )}

      {open ? (
        <div
          aria-modal
          role="dialog"
          tabIndex={-1}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4 dark:bg-black/60"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        >
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-surface p-6 shadow-xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-medium tracking-tight">
                  Customize profile
                </h2>
                <p className="mt-1 text-xs text-muted-3">
                  Lives at petdex.dev/u/{profile.handle}. Changes go live
                  instantly. No admin review.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full p-1 text-muted-4 hover:bg-surface-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
              className="space-y-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="profile-display-name"
                    className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                  >
                    Display name
                  </label>
                  <input
                    id="profile-display-name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    maxLength={48}
                    placeholder="Kevin Wu"
                    className="mt-1 h-10 w-full rounded-xl border border-border-base bg-surface px-3 text-sm focus:border-brand focus:outline-none"
                  />
                </div>
                <div>
                  <label
                    htmlFor="profile-handle"
                    className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                  >
                    Profile URL
                  </label>
                  <div className="mt-1 flex h-10 items-center rounded-xl border border-border-base bg-surface px-3 focus-within:border-brand">
                    <span className="shrink-0 font-mono text-xs text-muted-4">
                      /u/
                    </span>
                    <input
                      id="profile-handle"
                      value={handle}
                      onChange={(e) => setHandle(e.target.value.toLowerCase())}
                      maxLength={30}
                      placeholder="kevwuzy"
                      className="min-w-0 flex-1 bg-transparent font-mono text-sm text-foreground focus:outline-none"
                    />
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-muted-4">
                    3-30 lowercase letters, numbers, dashes or underscores.
                  </p>
                </div>
              </div>

              <div>
                <label
                  htmlFor="profile-bio"
                  className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                >
                  Bio
                </label>
                <textarea
                  id="profile-bio"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  maxLength={280}
                  rows={4}
                  placeholder="Pixel art, cozy creatures, and the occasional shrimp."
                  className="mt-1 w-full resize-none rounded-xl border border-border-base bg-surface px-3 py-2 text-sm focus:border-brand focus:outline-none"
                />
                <p className="mt-1 font-mono text-[10px] text-muted-4">
                  {bio.length}/280
                </p>
              </div>

              <div>
                <p className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase">
                  Pinned pets ({pinned.length}/{MAX_PINNED_PETS})
                </p>
                {profile.approvedPets.length === 0 ? (
                  <p className="mt-2 font-mono text-[10px] text-muted-4">
                    Once a pet is approved you can pin it here.
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {profile.approvedPets.map((p) => {
                      const active = pinned.includes(p.slug);
                      const capped =
                        !active && pinned.length >= MAX_PINNED_PETS;
                      return (
                        <button
                          type="button"
                          key={p.slug}
                          onClick={() => togglePin(p.slug)}
                          disabled={capped}
                          title={
                            capped
                              ? `Max ${MAX_PINNED_PETS} pinned. Unpin one first`
                              : active
                                ? "Click to unpin"
                                : "Click to pin"
                          }
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                            active
                              ? "border-brand bg-brand text-white hover:bg-brand-deep"
                              : "border-black/10 bg-surface text-muted-2 hover:border-black/30"
                          }`}
                        >
                          <Pin className="size-3" />
                          {p.displayName}
                        </button>
                      );
                    })}
                  </div>
                )}
                <p className="mt-2 font-mono text-[10px] text-muted-4">
                  Tip: each pet card on your profile has a one-click Pin button
                  too.
                </p>
              </div>

              {error ? (
                <p className="rounded-xl bg-chip-danger-bg px-3 py-2 text-xs text-chip-danger-fg">
                  {error.replace(/_/g, " ")}
                </p>
              ) : null}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="inline-flex h-9 items-center rounded-full border border-border-base bg-surface px-3 text-xs font-medium text-muted-2 transition hover:border-border-strong"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full bg-inverse px-4 text-xs font-medium text-on-inverse transition hover:bg-stone-800 disabled:opacity-60"
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
