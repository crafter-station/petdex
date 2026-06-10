"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  Check,
  X as CloseIcon,
  Copy,
  Download,
  ExternalLink,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { CodexLogo } from "@/components/codex-logo";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const SITE_URL = "https://petdex.dev";

export type PetActionMenuPet = {
  slug: string;
  displayName: string;
  zipUrl?: string | null;
  description?: string;
};

export type PetActionMenuOwnerActions = {
  submissionId: string;
  status: "pending" | "approved" | "rejected";
};

export type PetActionMenuContentProps = {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  pet: PetActionMenuPet;
  ownerActions?: PetActionMenuOwnerActions;
};

export function PetActionMenuContent({
  onOpenChange,
  open,
  pet,
  ownerActions,
}: PetActionMenuContentProps) {
  const t = useTranslations("petActions");
  const router = useRouter();
  const [copied, setCopied] = useState<"install" | "link" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);
  // canDelete is fetched lazily the first time the menu opens. The
  // public PetdexPet shape deliberately doesn't carry ownerId, so the
  // viewer/owner check has to round-trip. /api/pets/[slug]/can-delete
  // is auth-cookie gated and private, no-store — anonymous viewers
  // get false instantly.
  const [canDelete, setCanDelete] = useState<boolean | null>(null);

  const installCmd = `npx petdex install ${pet.slug}`;
  const pageUrl = `${SITE_URL}/pets/${pet.slug}`;

  // Lazy ownership check. Only fires the first time the menu opens —
  // result is cached in component state. If the user signs in / out
  // mid-session the menu won't notice until next mount, but that's
  // fine: the actual delete still re-checks ownership server-side.
  useEffect(() => {
    if (!open || canDelete !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/pets/${pet.slug}/can-delete`);
        if (!res.ok) {
          if (!cancelled) setCanDelete(false);
          return;
        }
        const data = (await res.json()) as { canDelete: boolean };
        if (!cancelled) setCanDelete(Boolean(data.canDelete));
      } catch {
        if (!cancelled) setCanDelete(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, canDelete, pet.slug]);

  const copyText = useCallback(
    async (text: string, kind: "install" | "link") => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(kind);
        window.setTimeout(() => setCopied(null), 1400);
      } catch {
        // ignore clipboard failures (Safari permission issues etc.)
      }
    },
    [],
  );

  const onShareX = useCallback(() => {
    const text = `${pet.displayName}: an animated Codex pet on Petdex.\n\n${installCmd}`;
    const url = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(pageUrl)}`;
    window.open(url, "_blank", "noopener,noreferrer,width=560,height=540");
    onOpenChange(false);
  }, [pet.displayName, installCmd, pageUrl, onOpenChange]);

  const onShareLinkedIn = useCallback(() => {
    const url = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(pageUrl)}`;
    window.open(url, "_blank", "noopener,noreferrer,width=620,height=600");
    onOpenChange(false);
  }, [pageUrl, onOpenChange]);

  const onShareNative = useCallback(async () => {
    if (typeof navigator === "undefined" || !("share" in navigator)) return;
    try {
      await (
        navigator as Navigator & {
          share: (data: ShareData) => Promise<void>;
        }
      ).share({
        title: `${pet.displayName} | Petdex`,
        text: `${pet.displayName}: an animated Codex pet`,
        url: pageUrl,
      });
      onOpenChange(false);
    } catch {
      // user cancelled, ignore
    }
  }, [pet.displayName, pageUrl, onOpenChange]);

  const onZipClick = useCallback(() => {
    void fetch(`/api/pets/${pet.slug}/track-zip`, { method: "POST" }).catch(
      () => {},
    );
    onOpenChange(false);
  }, [pet.slug, onOpenChange]);

  const onDelete = useCallback(async () => {
    if (deleting) return;
    // Two-step confirmation: typing the slug avoids muscle-memory
    // clicks wiping a pet you actually still want. Same pattern the
    // admin takedown uses.
    const typed = window.prompt(
      `Type "${pet.slug}" to confirm. This permanently removes ${pet.displayName} from Petdex and frees the slug. The pet's files and like history are deleted.`,
    );
    if (typed === null) return;
    if (typed.trim() !== pet.slug) {
      window.alert("Slug did not match. Pet was NOT removed.");
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/pets/${pet.slug}/owner`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "owner_self_delete" }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        setDeleteError(
          data.message ?? data.error ?? `Request failed (${res.status})`,
        );
        setDeleting(false);
        return;
      }
      onOpenChange(false);
      router.refresh();
    } catch {
      setDeleteError("network_error");
      setDeleting(false);
    }
  }, [deleting, pet.slug, pet.displayName, router, onOpenChange]);

  const onWithdraw = useCallback(async () => {
    if (withdrawing || !ownerActions) return;
    if (
      !window.confirm(
        `Withdraw "${pet.displayName}"? Pending submissions can't be brought back. You'd have to resubmit.`,
      )
    ) {
      return;
    }
    setWithdrawing(true);
    setWithdrawError(null);
    try {
      const res = await fetch(
        `/api/my-pets/${ownerActions.submissionId}/withdraw`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        setWithdrawError(
          data.message ?? data.error ?? `Request failed (${res.status})`,
        );
        setWithdrawing(false);
        return;
      }
      onOpenChange(false);
      router.refresh();
    } catch {
      setWithdrawError("network_error");
      setWithdrawing(false);
    }
  }, [withdrawing, ownerActions, pet.displayName, router, onOpenChange]);

  return (
    <>
      <div className="flex items-center justify-between border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.06]">
        <span className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
          {pet.displayName}
        </span>
        <button
          type="button"
          aria-label={t("closeMenu")}
          onClick={() => onOpenChange(false)}
          className="grid size-6 place-items-center rounded-full text-muted-4 transition hover:bg-surface-muted hover:text-foreground"
        >
          <CloseIcon className="size-3.5" />
        </button>
      </div>

      <div className="py-1">
        <DropdownMenuItem
          render={
            // biome-ignore lint/a11y/useAnchorContent: content is provided via DropdownMenuItem children (Base UI render prop pattern)
            <a
              href={`codex://new?prompt=${encodeURIComponent(`Install this Petdex pet by running: ${installCmd}`)}`}
            />
          }
          className="flex items-center gap-2.5 px-3 py-2 text-sm text-muted-2"
        >
          <CodexLogo className="size-4" />
          <span className="flex flex-col">
            <span>{t("openInCodex")}</span>
            <span className="font-mono text-[10px] tracking-tight text-muted-4">
              {t("openInCodexHint")}
            </span>
          </span>
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={() => copyText(installCmd, "install")}
          className="flex items-center gap-2.5 px-3 py-2 text-sm text-muted-2"
        >
          {copied === "install" ? (
            <Check className="size-4 text-emerald-600" />
          ) : (
            <Terminal className="size-4" />
          )}
          <span className="flex flex-col">
            <span>
              {copied === "install" ? t("copiedInstall") : t("copyInstall")}
            </span>
            <span className="font-mono text-[10px] tracking-tight text-muted-4">
              {installCmd}
            </span>
          </span>
          <Copy className="ml-auto size-3.5 text-stone-300 dark:text-stone-600" />
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={() => copyText(pageUrl, "link")}
          className="flex items-center gap-2.5 px-3 py-2 text-sm text-muted-2"
        >
          {copied === "link" ? (
            <Check className="size-4 text-emerald-600" />
          ) : (
            <Link2 className="size-4" />
          )}
          <span className="flex flex-col">
            <span>
              {copied === "link" ? t("copiedLink") : t("copyPageLink")}
            </span>
            <span className="font-mono text-[10px] tracking-tight text-muted-4">
              {pageUrl.replace(/^https?:\/\//, "")}
            </span>
          </span>
          <Copy className="ml-auto size-3.5 text-stone-300 dark:text-stone-600" />
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={onShareX}
          className="flex items-center gap-2.5 px-3 py-2 text-sm text-muted-2"
        >
          <XIcon className="size-4" />
          <span>{t("shareToX")}</span>
        </DropdownMenuItem>

        <DropdownMenuItem
          onClick={onShareLinkedIn}
          className="flex items-center gap-2.5 px-3 py-2 text-sm text-muted-2"
        >
          <LinkedInIcon className="size-4" />
          <span>{t("shareToLinkedIn")}</span>
        </DropdownMenuItem>

        {typeof navigator !== "undefined" && "share" in navigator ? (
          <DropdownMenuItem
            onClick={() => void onShareNative()}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-muted-2"
          >
            <ExternalLink className="size-4" />
            <span>{t("more")}</span>
          </DropdownMenuItem>
        ) : null}

        {pet.zipUrl ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              render={
                // biome-ignore lint/a11y/useAnchorContent: content is provided via DropdownMenuItem children (Base UI render prop pattern)
                <a
                  href={pet.zipUrl}
                  download
                  target="_blank"
                  rel="noreferrer"
                />
              }
              onClick={onZipClick}
              className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-muted-2"
            >
              <Download className="size-4" />
              <span className="flex-1">{t("downloadZip")}</span>
            </DropdownMenuItem>
          </>
        ) : null}

        {ownerActions?.status === "pending" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => void onWithdraw()}
              disabled={withdrawing}
              className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-chip-danger-fg"
            >
              {withdrawing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <XCircle className="size-4" />
              )}
              <span className="flex-1">
                {withdrawing ? t("withdrawing") : t("withdrawSubmission")}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}

        {ownerActions?.status === "rejected" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              render={<Link href="/submit" prefetch={false} />}
              className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-foreground"
            >
              <Plus className="size-4" />
              <span className="flex-1">{t("submitNewVersion")}</span>
            </DropdownMenuItem>
          </>
        ) : null}

        {ownerActions?.status === "approved" ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              render={<Link href={`/pets/${pet.slug}#edit`} prefetch={false} />}
              className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-foreground"
            >
              <Pencil className="size-4" />
              <span className="flex-1">{t("editDetails")}</span>
            </DropdownMenuItem>
          </>
        ) : null}

        {canDelete ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => void onDelete()}
              disabled={deleting}
              variant="destructive"
              className="flex items-center gap-2.5 px-3 py-2.5 text-sm"
            >
              {deleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              <span className="flex-1">
                {deleting ? t("removing") : t("removeFromPetdex")}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </div>

      {deleteError ? (
        <p className="border-t border-black/[0.06] bg-chip-danger-bg px-3 py-2 text-xs text-chip-danger-fg dark:border-white/[0.06]">
          {deleteError}
        </p>
      ) : null}
      {withdrawError ? (
        <p className="border-t border-black/[0.06] bg-chip-danger-bg px-3 py-2 text-xs text-chip-danger-fg dark:border-white/[0.06]">
          {withdrawError}
        </p>
      ) : null}
    </>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="currentColor"
    >
      <path d="M18.244 2H21l-6.55 7.49L22 22h-6.93l-4.83-6.31L4.6 22H1.84l7.01-8.02L1 2h7.07l4.36 5.78L18.244 2zm-2.43 18h1.91L7.27 4H5.27l10.544 16z" />
    </svg>
  );
}

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill="currentColor"
    >
      <path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8.34 18.34V10.5H5.67v7.84zm-1.34-9a1.55 1.55 0 1 0 0-3.1 1.55 1.55 0 0 0 0 3.1zm11.34 9v-4.49c0-2.4-1.28-3.52-2.99-3.52a2.58 2.58 0 0 0-2.34 1.29h-.04V10.5h-2.55v7.84h2.66v-3.88c0-1.02.2-2.01 1.46-2.01 1.25 0 1.27 1.17 1.27 2.07v3.82z" />
    </svg>
  );
}
