"use client";

import { useRouter } from "next/navigation";
import { memo, useCallback, useState } from "react";

import { useClerk } from "@clerk/nextjs";
import { track } from "@vercel/analytics";
import { Download, Heart, Loader2, Share2, TerminalSquare } from "lucide-react";

import { PetSoundButton } from "@/components/pet-sound-button";

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

  const [liked, setLiked] = useState(initialLiked ?? false);
  const [count, setCount] = useState(likeCount);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const toggleLike = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (busy) return;
      if (!clerk.loaded) return;
      const session = clerk.session;
      if (!session) {
        router.push("/?signin=1");
        return;
      }
      const next = !liked;
      setLiked(next);
      setCount((c) => Math.max(0, c + (next ? 1 : -1)));
      setBusy(true);
      track("pet_like_toggled", { slug, liked: next, source: "card-footer" });
      try {
        const res = await fetch(`/api/pets/${slug}/like`, { method: "POST" });
        if (!res.ok) {
          setLiked(!next);
          setCount((c) => Math.max(0, c + (next ? -1 : 1)));
          return;
        }
        const j = (await res.json().catch(() => null)) as {
          likeCount?: number;
          liked?: boolean;
        } | null;
        if (j && typeof j.likeCount === "number") setCount(j.likeCount);
        if (j && typeof j.liked === "boolean") setLiked(j.liked);
      } finally {
        setBusy(false);
      }
    },
    [busy, clerk, liked, router, slug],
  );

  const copyInstall = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const cmd = `npx petdex install ${slug}`;
      try {
        await navigator.clipboard.writeText(cmd);
        setCopied(true);
        track("pet_install_copied", { slug, source: "card-footer" });
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
      track("pet_zip_downloaded", { slug, source: "card-footer" });
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
      track("pet_shared", { slug, source: "card-footer" });
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
        <FooterBtn
          onClick={toggleLike}
          active={liked}
          label={`${liked ? "Unlike" : "Like"} ${displayName}`}
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
              {count}
            </span>
          ) : null}
        </FooterBtn>

        <FooterBtn
          onClick={copyInstall}
          active={copied}
          label={`Copy install for ${displayName}`}
        >
          <TerminalSquare className="size-3.5" />
          {installCount > 0 ? (
            <span className="font-mono text-[11px] text-muted-3">
              {installCount}
            </span>
          ) : null}
        </FooterBtn>

        {zipUrl ? (
          <FooterBtn onClick={download} label={`Download ${displayName}`}>
            <Download className="size-3.5" />
          </FooterBtn>
        ) : null}

        {soundUrl ? (
          <PetSoundButton soundUrl={soundUrl} displayName={displayName} />
        ) : null}

        <FooterBtn onClick={share} label={`Share ${displayName}`}>
          <Share2 className="size-3.5" />
        </FooterBtn>
      </div>

      {busy ? <Loader2 className="size-3.5 animate-spin text-muted-4" /> : null}
    </div>
  );
}

export const PetCardFooter = memo(PetCardFooterImpl);

const FooterBtn = memo(function FooterBtn({
  children,
  onClick,
  active,
  label,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent) => void;
  active?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex h-8 items-center gap-1 rounded-full px-2 transition ${
        active
          ? "bg-stone-100 text-stone-900 dark:text-stone-100"
          : "text-stone-500 hover:bg-surface-muted hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
      }`}
    >
      {children}
    </button>
  );
});
