"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Loader2, Pencil, X } from "lucide-react";
import { useTranslations } from "next-intl";

type Pending = {
  displayName: string | null;
  description: string | null;
  tags: string[] | null;
  submittedAt: string | null;
};

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\s]+/)) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    if (!TAG_RE.test(v)) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= 8) break;
  }
  return out;
}

export function OwnerEditPanel({
  petId,
  slug,
  currentDisplayName,
  currentDescription,
  currentTags,
  initialPending,
  initialRejection,
}: {
  petId: string;
  slug: string;
  currentDisplayName: string;
  currentDescription: string;
  currentTags: string[];
  initialPending: Pending | null;
  initialRejection: string | null;
}) {
  const t = useTranslations("myPets.edit");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<Pending | null>(initialPending);
  const [rejection, setRejection] = useState<string | null>(initialRejection);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  // Form state.
  const [displayName, setDisplayName] = useState(
    pending?.displayName ?? currentDisplayName,
  );
  const [description, setDescription] = useState(
    pending?.description ?? currentDescription,
  );
  const [tagsInput, setTagsInput] = useState(
    (pending?.tags ?? currentTags).join(", "),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setDisplayName(pending?.displayName ?? currentDisplayName);
      setDescription(pending?.description ?? currentDescription);
      setTagsInput((pending?.tags ?? currentTags).join(", "));
      setError(null);
    }
  }, [open, pending, currentDisplayName, currentDescription, currentTags]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const tags = parseTags(tagsInput);
      const res = await fetch(`/api/my-pets/${petId}/edit`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: displayName.trim(),
          description: description.trim(),
          tags,
        }),
      });
      const j = (await res.json().catch(() => null)) as {
        error?: string;
        pending?: Pending;
      } | null;
      if (!res.ok) {
        setError(j?.error ?? res.statusText);
        return;
      }
      setPending(j?.pending ?? null);
      setRejection(null);
      setOpen(false);
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!confirm(t("confirmWithdraw"))) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/my-pets/${petId}/edit`, {
        method: "DELETE",
      });
      if (!res.ok) return;
      setPending(null);
      startTransition(() => router.refresh());
    } finally {
      setBusy(false);
    }
  }

  const hasPending = pending && pending.submittedAt;

  return (
    <>
      {hasPending ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-amber-200 bg-chip-warning-bg px-3 py-2 text-xs text-chip-warning-fg dark:border-amber-800/60">
          <span className="font-mono text-[10px] tracking-[0.12em] uppercase">
            {t("pendingReview")}
          </span>
          <span>
            {t("submittedPrefix")}{" "}
            {pending && pending.submittedAt
              ? new Date(pending.submittedAt).toLocaleDateString()
              : ""}
            {t("submittedSuffix")}
          </span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ml-auto inline-flex h-7 items-center rounded-full border border-amber-300 bg-surface px-2.5 text-[11px] font-medium text-amber-900 transition hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/40"
          >
            {t("viewEdit")}
          </button>
          <button
            type="button"
            onClick={() => void withdraw()}
            disabled={busy}
            className="inline-flex h-7 items-center rounded-full border border-amber-300 bg-surface px-2.5 text-[11px] font-medium text-amber-900 transition hover:bg-amber-100 disabled:opacity-60 dark:text-amber-300 dark:hover:bg-amber-900/40"
          >
            {t("withdraw")}
          </button>
        </div>
      ) : rejection ? (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50/80 px-3 py-2 text-xs text-rose-900 dark:border-rose-800/60 dark:text-rose-300">
          <span className="font-mono text-[10px] tracking-[0.12em] uppercase">
            {t("rejected")}
          </span>
          <span>{rejection}</span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="ml-auto inline-flex h-7 items-center rounded-full border border-rose-300 bg-surface px-2.5 text-[11px] font-medium text-rose-900 transition hover:bg-rose-100 dark:text-rose-300 dark:hover:bg-rose-900/40"
          >
            {t("tryAgain")}
          </button>
        </div>
      ) : null}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border-base bg-surface px-3 text-xs font-medium text-muted-2 transition hover:border-black/40 dark:hover:border-white/40"
        >
          <Pencil className="size-3.5" />
          {t("open")}
        </button>
      ) : null}

      {open ? (
        <div
          aria-modal
          role="dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 dark:bg-black/60"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-lg rounded-2xl bg-surface p-6 shadow-xl">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-medium tracking-tight">
                  {t("modalTitle")}
                </h2>
                <p className="mt-1 text-xs text-muted-3">
                  {t("modalBody")}
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
                void submit();
              }}
              className="space-y-4"
            >
              <div>
                <label
                  htmlFor="edit-display-name"
                  className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                >
                  {t("fields.displayName")}
                </label>
                <input
                  id="edit-display-name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={60}
                  className="mt-1 w-full rounded-xl border border-border-base bg-surface px-3 py-2 text-sm focus:border-brand focus:outline-none"
                />
                <p className="mt-1 font-mono text-[10px] text-muted-4">
                  {displayName.length}/60
                </p>
              </div>

              <div>
                <label
                  htmlFor="edit-description"
                  className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                >
                  {t("fields.description")}
                </label>
                <textarea
                  id="edit-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={280}
                  rows={4}
                  className="mt-1 w-full resize-none rounded-xl border border-border-base bg-surface px-3 py-2 text-sm focus:border-brand focus:outline-none"
                />
                <p className="mt-1 font-mono text-[10px] text-muted-4">
                  {description.length}/280
                </p>
              </div>

              <div>
                <label
                  htmlFor="edit-tags"
                  className="font-mono text-[10px] tracking-[0.12em] text-muted-3 uppercase"
                >
                  {t("fields.tags")}
                </label>
                <input
                  id="edit-tags"
                  value={tagsInput}
                  onChange={(e) => setTagsInput(e.target.value)}
                  placeholder={t("tagsPlaceholder")}
                  className="mt-1 w-full rounded-xl border border-border-base bg-surface px-3 py-2 text-sm focus:border-brand focus:outline-none"
                />
                <p className="mt-1 font-mono text-[10px] text-muted-4">
                  {t("tagsHelp")}
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
                  {t("actions.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full bg-inverse px-4 text-xs font-medium text-on-inverse transition hover:bg-stone-800 disabled:opacity-60"
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  {t("actions.submit")}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
