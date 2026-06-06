"use client";

import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { useClerk } from "@clerk/nextjs";
import { Download, Heart, Share2, TerminalSquare } from "lucide-react";
import { useLocale } from "next-intl";

import { formatLocalizedNumber } from "@/lib/format-number";
import { cn } from "@/lib/utils";

import { useHeaderState } from "@/components/header-state-provider";
import { PetSoundButton } from "@/components/pet-sound-button";
import { Button } from "@/components/ui/button";

// Inline footer bar at the bottom of each gallery card. Surfaces the
// four most-used actions (like, install, download, share) without
// forcing the user to open the pet page or the overflow menu.
//
// Buttons stop propagation so a click on a footer action does not
// also fire the card-wide Link wrapper that the parent renders.
function PetCardFooterImpl({
  slug,
  displayName,
  zipUrl,
  soundUrl,
  installCount,
  likeCount,
  initialLiked,
}: {
  slug: string;
  displayName: string;
  zipUrl?: string;
  soundUrl: string | null;
  installCount: number;
  likeCount: number;
  initialLiked?: boolean;
}) {
  const router = useRouter();
  const clerk = useClerk();
  const locale = useLocale();
  const { refresh } = useHeaderState();

  const [liked, setLiked] = useState(initialLiked ?? false);
  const [count, setCount] = useState(likeCount);
  const [copied, setCopied] = useState(false);
  const likeRequestSeq = useRef(0);
  const formattedLikeCount = formatLocalizedNumber(count, locale);
  const formattedInstallCount = formatLocalizedNumber(installCount, locale);

  useEffect(() => {
    if (typeof initialLiked === "boolean") setLiked(initialLiked);
  }, [initialLiked]);

  const toggleLike = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!clerk.loaded) return;
      const session = clerk.session;
      if (!session) {
        router.push("/?signin=1");
        return;
      }
      const seq = likeRequestSeq.current + 1;
      likeRequestSeq.current = seq;
      const previousLiked = liked;
      const previousCount = count;
      const next = !liked;
      setLiked(next);
      setCount((c) => Math.max(0, c + (next ? 1 : -1)));
      try {
        const res = await fetch(`/api/pets/${slug}/like`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ liked: next }),
        });
        if (!res.ok) {
          if (likeRequestSeq.current === seq) {
            setLiked(previousLiked);
            setCount(previousCount);
          }
          return;
        }
        const j = (await res.json().catch(() => null)) as {
          count?: number;
          likeCount?: number;
          liked?: boolean;
        } | null;
        if (likeRequestSeq.current !== seq) return;
        const serverCount =
          typeof j?.count === "number" ? j.count : j?.likeCount;
        if (typeof serverCount === "number") setCount(serverCount);
        if (typeof j?.liked === "boolean") setLiked(j.liked);
        void refresh({ force: true });
      } catch {
        if (likeRequestSeq.current === seq) {
          setLiked(previousLiked);
          setCount(previousCount);
        }
      }
    },
    [clerk, count, liked, refresh, router, slug],
  );

  const copyInstall = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const cmd = `npx petdex install ${slug}`;
      try {
        await navigator.clipboard.writeText(cmd);
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      } catch {
        /* swallow */
      }
    },
    [slug],
  );

  const download = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!zipUrl) return;
      const a = document.createElement("a");
      a.href = zipUrl;
      a.download = `${slug}.zip`;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
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
      } catch {
        /* swallow */
      }
    },
    [displayName, slug],
  );

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-black/[0.05] px-2 py-2 dark:border-white/[0.05]">
      <div className="flex min-w-0 flex-wrap items-center gap-0.5">
        <Button
          variant="ghost"
          onClick={toggleLike}
          aria-label={`${liked ? "Unlike" : "Like"} ${displayName}`}
          title={`${liked ? "Unlike" : "Like"} ${displayName}`}
          className={cn(
            "h-8 gap-1 rounded-full px-2",
            liked
              ? "bg-stone-100 text-stone-900 dark:text-stone-100"
              : "text-stone-500 hover:bg-surface-muted hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100",
          )}
        >
          <Heart
            className={`size-3.5 ${liked ? "fill-rose-500 text-rose-500" : ""}`}
          />
          {count > 0 ? (
            <span
              className={`font-mono text-[11px] ${
                liked ? "text-rose-600" : "text-stone-500"
              }`}
            >
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
