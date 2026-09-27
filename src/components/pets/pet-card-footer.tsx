"use client";

import { memo, useCallback, useEffect, useState } from "react";

import { Download, Heart, Share2, TerminalSquare } from "lucide-react";
import { useLocale } from "next-intl";

import { downloadPetZip } from "@/lib/download-pet-zip";
import { formatLocalizedNumber } from "@/lib/format-number";
import { cn } from "@/lib/utils";

import { useAuthIntent } from "@/components/auth/auth-intent";
import { PetSoundButton } from "@/components/pets/pet-sound-button";
import { Button } from "@/components/ui/button";

export type PetCardFooterProps = {
  slug: string;
  displayName: string;
  zipUrl?: string;
  soundUrl: string | null;
  installCount: number;
  likeCount: number;
  initialLiked?: boolean;
};

type PetCardFooterComponent = React.ComponentType<PetCardFooterProps>;

function PetCardFooterImpl({
  slug,
  displayName,
  zipUrl,
  soundUrl,
  installCount,
  likeCount,
}: PetCardFooterProps) {
  const { authActive, requestAuth } = useAuthIntent();
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  const [AuthPetCardFooter, setAuthPetCardFooter] =
    useState<PetCardFooterComponent | null>(null);
  const formattedLikeCount = formatLocalizedNumber(likeCount, locale);
  const formattedInstallCount = formatLocalizedNumber(installCount, locale);

  useEffect(() => {
    if (!authActive || AuthPetCardFooter) return;
    let cancelled = false;
    void import("@/components/pets/pet-card-footer-auth").then((mod) => {
      if (!cancelled) setAuthPetCardFooter(() => mod.PetCardFooter);
    });
    return () => {
      cancelled = true;
    };
  }, [AuthPetCardFooter, authActive]);

  const copyInstall = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const cmd = `npx petdex install ${slug}`;
      try {
        await navigator.clipboard.writeText(cmd);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      } catch {}
    },
    [slug],
  );

  const download = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!zipUrl) return;
      void downloadPetZip(zipUrl, slug);
    },
    [slug, zipUrl],
  );

  const share = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const url = `${typeof window !== "undefined" ? window.location.origin : ""}/pets/${slug}`;
      if (navigator.share) {
        navigator.share({ title: displayName, url }).catch(() => {});
        return;
      }
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      } catch {}
    },
    [displayName, slug],
  );

  const requestLikeAuth = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      requestAuth();
    },
    [requestAuth],
  );

  if (authActive && AuthPetCardFooter) {
    return (
      <AuthPetCardFooter
        slug={slug}
        displayName={displayName}
        zipUrl={zipUrl}
        soundUrl={soundUrl}
        installCount={installCount}
        likeCount={likeCount}
      />
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.05] px-2 py-2 dark:border-white/[0.05]">
      <div className="flex min-w-0 flex-wrap items-center gap-0.5">
        <Button
          variant="ghost"
          onClick={requestLikeAuth}
          aria-label={`Like ${displayName}`}
          title={`Like ${displayName}`}
          className="h-8 gap-1 rounded-full px-2 text-stone-500 hover:bg-surface-muted hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
        >
          <Heart className="size-3.5" />
          {likeCount > 0 ? (
            <span className="font-mono text-[11px] text-stone-500">
              {formattedLikeCount}
            </span>
          ) : null}
        </Button>

        <Button
          variant="ghost"
          onClick={copyInstall}
          aria-label={`Copy install for ${displayName}`}
          title={`Copy install for ${displayName}`}
          className={cn(
            "h-8 gap-1 rounded-full px-2",
            copied
              ? "bg-stone-100 text-stone-900 dark:text-stone-100"
              : "text-stone-500 hover:bg-surface-muted hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100",
          )}
        >
          <TerminalSquare className="size-3.5" />
          {installCount > 0 ? (
            <span className="font-mono text-[11px] text-muted-3">
              {formattedInstallCount}
            </span>
          ) : null}
        </Button>

        {zipUrl ? (
          <Button
            variant="ghost"
            onClick={download}
            aria-label={`Download ${displayName}`}
            title={`Download ${displayName}`}
            className="h-8 gap-1 rounded-full px-2 text-stone-500 hover:bg-surface-muted hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <Download className="size-3.5" />
          </Button>
        ) : null}

        {soundUrl ? (
          <PetSoundButton soundUrl={soundUrl} displayName={displayName} />
        ) : null}

        <Button
          variant="ghost"
          onClick={share}
          aria-label={`Share ${displayName}`}
          title={`Share ${displayName}`}
          className="h-8 gap-1 rounded-full px-2 text-stone-500 hover:bg-surface-muted hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
        >
          <Share2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

export const PetCardFooter = memo(PetCardFooterImpl);
