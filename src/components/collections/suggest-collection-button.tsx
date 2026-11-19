"use client";

// Lets a pet owner request that their pet be added to a featured
// collection. The button only renders for owners (gated server-side
// before this component mounts). Click → small panel with collection
// picker → POST /api/collections/[slug]/request → toast.

import { useState, useTransition } from "react";

import { Layers, X } from "lucide-react";
import { useTranslations } from "next-intl";

type Collection = { slug: string; title: string };

// The route answers with these codes; the panel used to render the raw one.
const SUGGEST_ERROR_KEYS: Record<string, string> = {
  unauthorized: "unauthorized",
  rate_limited: "rateLimited",
  invalid_pet_slug: "invalidPetSlug",
  url_in_field: "urlInField",
  blocked_content: "blockedContent",
  collection_not_found: "collectionNotFound",
  pet_not_owned: "petNotOwned",
  pet_not_approved: "petNotApproved",
  already_in_collection: "alreadyInCollection",
};

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
        // A 409 here means already_in_collection (the route answers the
        // idempotent already-pending case with a 200). The old condition
        // treated every 409 as success, so a pet already in the collection
        // got marked "pending" instead of surfacing the real reason.
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(body.error ?? `http_${res.status}`);
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
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-9 w-fit items-center gap-1.5 rounded-full border border-border-base bg-surface/70 px-3 text-xs font-medium text-muted-2 backdrop-blur transition hover:bg-surface-muted hover:text-foreground"
        >
          <Layers className="size-3.5" />
          {t("cta")}
        </button>
      ) : (
        <div className="flex flex-col gap-3 rounded-2xl border border-border-base bg-surface/80 p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="font-mono text-[11px] tracking-[0.18em] text-muted-3 uppercase">
              {t("heading", { name: petDisplayName })}
            </p>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setTarget(null);
                setError(null);
              }}
              aria-label={t("closeAria")}
              className="grid size-7 place-items-center rounded-full text-muted-3 transition hover:bg-surface hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {candidateCollections.map((c) => {
              const requested = submitted.has(c.slug);
              const isTarget = target === c.slug;
              return (
                <button
                  key={c.slug}
                  type="button"
                  disabled={requested}
                  aria-pressed={isTarget}
                  onClick={() => setTarget(isTarget ? null : c.slug)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                    requested
                      ? "border-border-base bg-surface-muted text-muted-3"
                      : isTarget
                        ? "border-brand/40 bg-brand/15 text-brand"
                        : "border-border-base bg-surface/70 text-muted-2 hover:bg-surface-muted hover:text-foreground"
                  } disabled:cursor-not-allowed`}
                >
                  {c.title}
                  {requested ? t("pendingSuffix") : ""}
                </button>
              );
            })}
          </div>

          {target ? (
            // aria-label because the placeholder is the field's only name
            // otherwise, and it disappears on the first keystroke.
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 500))}
              placeholder={t("notePlaceholder")}
              aria-label={t("notePlaceholder")}
              rows={2}
              className="w-full rounded-2xl border border-border-base bg-surface p-3 text-sm text-foreground placeholder:text-muted-3 focus:border-border-strong focus:outline-none"
            />
          ) : null}

          {error ? (
            <p
              role="alert"
              className="rounded-2xl border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
            >
              {SUGGEST_ERROR_KEYS[error]
                ? t(`errors.${SUGGEST_ERROR_KEYS[error]}`)
                : t("errors.failed", { code: error })}
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={!target || isSaving}
              className="inline-flex h-9 items-center justify-center rounded-full bg-inverse px-4 text-xs font-medium text-on-inverse transition hover:bg-inverse-hover disabled:opacity-50"
            >
              {isSaving ? t("sending") : t("sendForReview")}
            </button>
          </div>

          <p className="text-[11px] text-muted-3">{t("footer")}</p>
        </div>
      )}
    </div>
  );
}
