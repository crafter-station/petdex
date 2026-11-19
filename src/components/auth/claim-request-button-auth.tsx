"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import { useAuth, useClerk } from "@clerk/nextjs";
import { Check, HandHeart, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type ApprovedPet = {
  id: string;
  slug: string;
  displayName: string;
  spritesheetUrl: string;
};

// The route answers with these codes; the dialog used to render the raw one.
const CLAIM_ERROR_KEYS: Record<string, string> = {
  exists: "exists",
  request_not_open: "requestNotOpen",
  pet_not_approved: "petNotApproved",
};

export function ClaimRequestButton({
  requestId,
  requestQuery,
}: {
  requestId: string;
  requestQuery: string;
}) {
  const t = useTranslations("claimRequest");
  const { isLoaded, isSignedIn } = useAuth();
  const { openSignIn } = useClerk();
  const [open, setOpen] = useState(false);
  const [pets, setPets] = useState<ApprovedPet[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Fetch approved pets only when the dialog opens (avoids one fetch
  // per visible request card on /requests).
  useEffect(() => {
    if (!open || pets !== null) return;
    setLoading(true);
    setError(null);
    void fetch("/api/my-pets/approved", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`http_${res.status}`);
        }
        const data = (await res.json()) as { pets: ApprovedPet[] };
        setPets(data.pets);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [open, pets]);

  function handleTriggerClick(e: React.MouseEvent) {
    if (!isLoaded) return;
    if (!isSignedIn) {
      e.preventDefault();
      openSignIn();
    }
  }

  async function submit() {
    if (!selected) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/pet-requests/${requestId}/candidates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ petId: selected }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(j?.error ?? `http_${res.status}`);
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown");
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setOpen(false);
    setTimeout(() => {
      setSelected(null);
      setError(null);
      setDone(false);
      // Drop the cached list: a pet claimed (or a new one approved) since
      // the last open would otherwise keep being offered and be rejected
      // server-side with `exists`. The next open refetches.
      setPets(null);
    }, 200);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button
            type="button"
            onClick={handleTriggerClick}
            className="inline-flex items-center gap-1.5 rounded-full border border-border-base bg-surface-muted px-2.5 py-1 font-mono text-[11px] tracking-[0.04em] text-muted-2 transition hover:border-brand/30 hover:bg-brand-tint hover:text-brand-deep dark:hover:bg-brand-tint-dark"
          >
            <HandHeart className="size-3" />
            {t("trigger")}
          </button>
        }
      />
      <DialogContent className="sm:max-w-md">
        {done ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                <Check className="size-4 text-chip-success-fg" />
                {t("submittedTitle")}
              </DialogTitle>
              <DialogDescription>{t("submittedBody")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="petdex-cta"
                onClick={reset}
                className="px-4 text-sm"
              >
                {t("done")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-base">
                {t("title", { query: requestQuery })}
              </DialogTitle>
              <DialogDescription>{t("description")}</DialogDescription>
            </DialogHeader>

            <div className="max-h-72 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="size-4 animate-spin text-muted-3" />
                </div>
              ) : pets && pets.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border-base p-4 text-center text-sm text-muted-2">
                  {t("noApprovedPets")}
                  <a
                    href="/submit"
                    className="ml-1 font-medium text-brand-deep underline"
                  >
                    {t("submitOne")}
                  </a>
                </div>
              ) : (
                <ul className="grid gap-1">
                  {pets?.map((pet) => {
                    const active = selected === pet.id;
                    return (
                      <li key={pet.id}>
                        <button
                          type="button"
                          onClick={() => setSelected(pet.id)}
                          aria-pressed={active}
                          className={`flex w-full items-center gap-3 rounded-xl border p-2 text-left transition ${
                            active
                              ? "border-brand bg-brand-tint dark:bg-brand-tint-dark"
                              : "border-transparent hover:bg-surface-muted"
                          }`}
                        >
                          <Image
                            src={pet.spritesheetUrl}
                            alt=""
                            width={40}
                            height={40}
                            className="size-10 shrink-0 rounded-lg bg-surface-muted object-cover"
                          />
                          <span className="flex-1 truncate text-sm text-foreground">
                            {pet.displayName}
                          </span>
                          {active ? (
                            <Check className="size-4 shrink-0 text-brand" />
                          ) : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {error ? (
              <p
                role="alert"
                className="rounded-lg bg-chip-danger-bg p-2 font-mono text-[10px] text-chip-danger-fg"
              >
                {CLAIM_ERROR_KEYS[error]
                  ? t(`errors.${CLAIM_ERROR_KEYS[error]}`)
                  : error.startsWith("http_")
                    ? t("errors.loadFailed", { status: error.slice(5) })
                    : error === "unknown"
                      ? t("errors.unknown")
                      : t("errors.failed", { code: error })}
              </p>
            ) : null}

            <DialogFooter>
              <DialogClose
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-sm text-muted-2"
                  >
                    {t("cancel")}
                  </Button>
                }
              />
              <Button
                type="button"
                variant="petdex-cta"
                disabled={!selected || submitting}
                onClick={submit}
                className="px-4 text-sm"
              >
                {submitting ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : null}
                {t("submitCandidate")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
