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
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#D4DCF4]/70 px-2.5 py-2 dark:border-white/10">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          size="default"
          onClick={requestLikeAuth}
          aria-label={`Like ${displayName}`}
          title={`Like ${displayName}`}
          className="h-8 gap-1 rounded-xl px-2 text-muted-2"
        >
          <Heart className="size-3.5" />
          {likeCount > 0 ? (
            <span className="font-hardware text-[10px] text-muted-3">
              {formattedLikeCount}
            </span>
          ) : null}
        </Button>

        <Button
          variant={copied ? "volt" : "ghost"}
          size="default"
          onClick={copyInstall}
          aria-label={`Copy install for ${displayName}`}
          title={`Copy install for ${displayName}`}
          className={cn("h-8 gap-1 rounded-xl px-2", !copied && "text-muted-2")}
        >
          <TerminalSquare className="size-3.5" />
          {installCount > 0 ? (
            <span className="font-hardware text-[10px] text-muted-3">
              {formattedInstallCount}
            </span>
          ) : null}
        </Button>

        {zipUrl ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={download}
            aria-label={`Download ${displayName}`}
            title={`Download ${displayName}`}
            className="rounded-xl text-muted-2"
          >
            <Download className="size-3.5" />
          </Button>
        ) : null}

        {soundUrl ? (
          <PetSoundButton soundUrl={soundUrl} displayName={displayName} />
        ) : null}

        <Button
          variant="ghost"
          size="icon"
          onClick={share}
          aria-label={`Share ${displayName}`}
          title={`Share ${displayName}`}
          className="rounded-xl text-muted-2"
        >
          <Share2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

export const PetCardFooter = memo(PetCardFooterImpl);
