"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Loader2, Pencil, Pin, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { MAX_PINNED_PETS } from "@/lib/profiles";
import { useFocusTrap } from "@/lib/use-focus-trap";

import { useHeaderState } from "@/components/layout/header-state-provider";
import { profileErrorKey } from "@/components/profile/profile-error-key";

type ApprovedPet = {
  slug: string;
  displayName: string;
};

// Inline editor used on /u/[handle] when the viewer owns the profile.
// Lighter than ProfileCard (which is the dashboard summary in /my-pets):
// here the surrounding hero already shows handle/avatar, so we only need
// the bio + pinned pets form. Optimistic — no admin re-approval.
export function ProfileInlineEditor({
  handle,
  initialDisplayName,
  initialBio,
  initialFeaturedSlugs,
  approvedPets,
}: {
  handle: string;
  initialDisplayName: string | null;
  initialBio: string | null;
  initialFeaturedSlugs: string[];
  approvedPets: ApprovedPet[];
}) {
  const t = useTranslations("profile");
  const tp = useTranslations("profileEditor");
  const te = useTranslations("profileEditor.errors");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(open, dialogRef);
  const [displayName, setDisplayName] = useState(initialDisplayName ?? "");
  const [profileHandle, setProfileHandle] = useState(handle);
  const [bio, setBio] = useState(initialBio ?? "");
  const [pinned, setPinned] = useState<string[]>(initialFeaturedSlugs);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorKey = profileErrorKey(error);
  const { refresh: refreshHeaderState } = useHeaderState();
  const [, startTransition] = useTransition();

  // Re-seed from the server whenever the dialog is closed. Without this the
  // component keeps whatever it mounted with: the page is force-dynamic and
  // the pin button beside it calls router.refresh(), which re-renders the
  // RSC payload but preserves this component's state — so a pin made after
  // mount is invisible here, and saving an unrelated field (the bio) sends
  // the stale `featuredPetSlugs` back and silently un-pins it. The sibling
  // ProfileCard resets the same way for the same reason. Skipped while open
  // so a refresh landing mid-edit cannot overwrite what the user is typing.
  useEffect(() => {
    if (open) return;
    setDisplayName(initialDisplayName ?? "");
    setProfileHandle(handle);
    setBio(initialBio ?? "");
    setPinned(initialFeaturedSlugs);
    setError(null);
  }, [open, initialDisplayName, initialBio, initialFeaturedSlugs, handle]);

  // The route answers with an internal code, and this panel used to render it
  // through `error.replace(/_/g, " ")` — which turns `handle_taken` into
  // "HANDLE TAKEN", not a sentence in any language. Map every code
  // `validateProfileHandle` can put on the wire (the route sends
  // `handle_${validation}`, and the validator returns too_short, too_long,
  // invalid_format and reserved); anything else falls back to one message
  // carrying the code.
  function togglePin(slug: string) {
    setPinned((prev) => {
      if (prev.includes(slug)) return prev.filter((s) => s !== slug);
      if (prev.length >= MAX_PINNED_PETS) return prev;
      return [...prev, slug];
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim() || null,
          handle: profileHandle.trim() || null,
          bio: bio.trim() || null,
          featuredPetSlugs: pinned,
        }),
      });
      const j = (await res.json().catch(() => null)) as {
        error?: string;
        handle?: string | null;
      } | null;
      if (!res.ok) {
        setError(j?.error ?? `http_${res.status}`);
        return;
      }
      setOpen(false);
      await refreshHeaderState({ force: true });
      if (j?.handle && j.handle !== handle) {
        startTransition(() => router.replace(`/u/${j.handle}`));
      } else {
        startTransition(() => router.refresh());
      }
    } catch {
      // A network failure rejects here; without this the handler rejected
      // unhandled and the dialog sat with no message at all.
      setError("network");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center gap-1.5 rounded-full bg-inverse px-3 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover"
      >
        <Pencil className="size-3.5" />
        {t("editProfile")}
      </button>

      {open ? (
        <div
          ref={dialogRef}
          aria-modal
          aria-labelledby="profile-inline-editor-title"
          role="dialog"
          tabIndex={-1}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4"
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
                <h2
                  id="profile-inline-editor-title"
                  className="text-xl font-medium tracking-tight"
                >
                  {tp("title")}
                </h2>
                <p className="mt-1 text-xs text-muted-3">
                  {tp("subtitle", { handle })}
                </p>
              </div>
              <button
                type="button"
                aria-label={tp("a11y.close")}
                onClick={() => setOpen(false)}
                className="rounded-full p-1 text-muted-3 hover:bg-surface-muted hover:text-foreground"
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
                    htmlFor="profile-inline-display-name"
                    className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                  >
                    {tp("displayName")}
                  </label>
                  <input
                    id="profile-inline-display-name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    maxLength={48}
                    placeholder={tp("displayNamePlaceholder")}
                    className="mt-1 h-10 w-full rounded-xl border border-border-base bg-surface px-3 text-sm text-foreground focus:border-brand focus:outline-none"
                  />
                </div>
                <div>
                  <label
                    htmlFor="profile-inline-handle"
                    className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                  >
                    {tp("profileUrl")}
                  </label>
                  <div className="mt-1 flex h-10 items-center rounded-xl border border-border-base bg-surface px-3 focus-within:border-brand">
                    <span className="shrink-0 font-mono text-xs text-muted-4">
                      /u/
                    </span>
                    <input
                      id="profile-inline-handle"
                      value={profileHandle}
                      onChange={(e) =>
                        setProfileHandle(e.target.value.toLowerCase())
                      }
                      maxLength={30}
                      placeholder={tp("handlePlaceholder")}
                      className="min-w-0 flex-1 bg-transparent font-mono text-sm text-foreground focus:outline-none"
                    />
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-muted-4">
                    {tp("handleHint")}
                  </p>
                </div>
              </div>

              <div>
                <label
                  htmlFor="profile-inline-bio"
                  className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                >
                  {tp("bio")}
                </label>
                <textarea
                  id="profile-inline-bio"
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  maxLength={280}
                  rows={4}
                  placeholder={tp("bioPlaceholder")}
                  className="mt-1 w-full resize-none rounded-xl border border-border-base bg-surface px-3 py-2 text-sm text-foreground focus:border-brand focus:outline-none"
                />
                <p className="mt-1 font-mono text-[10px] text-muted-4">
                  {bio.length}/280
                </p>
              </div>

              <div>
                <p className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase">
                  {tp("pinnedPets", {
                    pinned: pinned.length,
                    max: MAX_PINNED_PETS,
                  })}
                </p>
                {approvedPets.length === 0 ? (
                  <p className="mt-2 font-mono text-[10px] text-muted-4">
                    {tp("noApprovedPets")}
                  </p>
                ) : (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {approvedPets.map((p) => {
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
                              ? tp("pinCapTitle", { max: MAX_PINNED_PETS })
                              : active
                                ? tp("clickToUnpin")
                                : tp("clickToPin")
                          }
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                            active
                              ? "border-brand bg-brand text-on-inverse hover:bg-brand-deep"
                              : "border-border-base bg-surface text-muted-2 hover:border-border-strong"
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
                  {tp("pinTip")}
                </p>
              </div>

              {error ? (
                <p
                  role="alert"
                  className="rounded-xl bg-chip-danger-bg px-3 py-2 text-xs text-chip-danger-fg"
                >
                  {errorKey === "pinCapReached"
                    ? te("pinCapReached", { max: MAX_PINNED_PETS })
                    : errorKey
                      ? te(errorKey)
                      : te("failed", { code: error })}
                </p>
              ) : null}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="inline-flex h-9 items-center rounded-full border border-border-base bg-surface px-3 text-xs font-medium text-muted-2 transition hover:border-border-strong"
                >
                  {tp("cancel")}
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full bg-inverse px-4 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover disabled:opacity-60"
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {tp("save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
