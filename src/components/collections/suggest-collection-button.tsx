"use client";

// Lets a pet owner request that their pet be added to a featured
// collection. The button only renders for owners (gated server-side
// before this component mounts). Click → small panel with collection
// picker → POST /api/collections/[slug]/request → toast.

import { useState, useTransition } from "react";

import { Layers, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

type Collection = { slug: string; title: string };

type SuggestCollectionButtonProps = {
  petSlug: string;
  petDisplayName: string;
  // Featured collections the pet is *not* already in. We compute that
  // server-side so this client never has to hit a list endpoint.
  candidateCollections: Collection[];
  // Slugs of pending requests the owner already submitted, so we can
  // disable those rows instead of letting the user spam.
  alreadyRequested: string[];
};

export function SuggestCollectionButton({
  petSlug,
  petDisplayName,
  candidateCollections,
  alreadyRequested,
}: SuggestCollectionButtonProps) {
  const t = useTranslations("suggestCollection");
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [submitted, setSubmitted] = useState<Set<string>>(
    new Set(alreadyRequested),
  );
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startSave] = useTransition();

  if (candidateCollections.length === 0) return null;

  function submit() {
    if (!target) return;
    const collectionSlug = target;
    setError(null);
    startSave(async () => {
      try {
        const res = await fetch(`/api/collections/${collectionSlug}/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ petSlug, note: note || undefined }),
        });
        if (!res.ok && res.status !== 409) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `submit failed (${res.status})`);
        }
        setSubmitted((prev) => new Set(prev).add(collectionSlug));
        setTarget(null);
        setNote("");
      } catch (err) {
        setError((err as Error).message);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {!open ? (
        <Button
          type="button"
          variant="pearl"
          size="lg"
          onClick={() => setOpen(true)}
          className="w-fit"
        >
          <Layers className="size-3.5" />
          {t("cta")}
        </Button>
      ) : (
        <div className="toy-shell flex flex-col gap-3 rounded-2xl border border-[#D4DCF4] p-4 dark:border-white/12">
          <div className="flex items-center justify-between gap-2">
            <p className="toy-tag text-muted-3">
              Suggest {petDisplayName} for…
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setOpen(false);
                setTarget(null);
                setError(null);
              }}
              aria-label={t("closeAria")}
            >
              <X className="size-3.5" />
            </Button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {candidateCollections.map((c) => {
              const requested = submitted.has(c.slug);
              const isTarget = target === c.slug;
              return (
                <Button
                  key={c.slug}
                  type="button"
                  variant={isTarget ? "cobalt" : "pearl"}
                  size="sm"
                  disabled={requested}
                  onClick={() => setTarget(isTarget ? null : c.slug)}
                >
                  {c.title}
                  {requested ? " · pending" : ""}
                </Button>
              );
            })}
          </div>

          {target ? (
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 500))}
              placeholder={t("notePlaceholder")}
              rows={2}
              className="w-full rounded-xl border border-[#D4DCF4] bg-surface p-3 text-sm text-foreground placeholder:text-muted-3 focus:border-[#3B59F2] focus:outline-none dark:border-white/12"
            />
          ) : null}

          {error ? (
            <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              {error}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="cobalt"
              size="lg"
              onClick={submit}
              disabled={!target || isSaving}
            >
              {isSaving ? "Sending…" : "Send for review"}
            </Button>
          </div>

          <p className="text-[11px] text-muted-3">
            Admins review every request. You'll see your pet in the collection
            once it's approved.
          </p>
        </div>
      )}
    </div>
  );
}
