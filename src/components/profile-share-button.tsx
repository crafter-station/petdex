"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { track } from "@vercel/analytics";
import { Check, X as CloseIcon, Link2, Share2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { createPortal } from "react-dom";

const SITE_URL = "https://petdex.crafter.run";

type Props = {
  /** Public handle without leading @ — used to build the URL. */
  handle: string;
  /** Display name surfaced in the share text. Falls back to @handle when null. */
  displayName: string | null;
};

// Profile-level share button. Sits next to "Edit profile" in the
// header so creators have an obvious affordance to spread their page.
// Visible to everyone (owner + visitor) — fans sharing a profile they
// like is the same growth motion as the creator promoting themselves.
//
// Surfaces: Copy link, Share to X, Share to LinkedIn, native Share
// (when the browser supports it). The same set the per-pet action
// menu uses, just scoped to the /u/<handle> URL. We portal the
// dropdown to <body> so the parent stacking context can't clip it.
export function ProfileShareButton({ handle, displayName }: Props) {
  const t = useTranslations("profileShare");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [mounted, setMounted] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
  } | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  const profileUrl = `${SITE_URL}/u/${handle}`;
  const shareLabel = displayName ?? `@${handle}`;
  const shareText = t("shareText", { name: shareLabel });

  const computePos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const MENU_WIDTH = 256;
    const top = rect.bottom + 8;
    const left = Math.max(8, rect.right - MENU_WIDTH);
    setMenuPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    computePos();
  }, [open, computePos]);

  useEffect(() => {
    if (!open) return;
    const h = () => computePos();
    window.addEventListener("resize", h);
    window.addEventListener("scroll", h, true);
    return () => {
      window.removeEventListener("resize", h);
      window.removeEventListener("scroll", h, true);
    };
  }, [open, computePos]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(profileUrl);
      setCopied(true);
      track("profile_share", { handle, target: "copy" });
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore clipboard failures */
    }
  }, [handle, profileUrl]);

  const onShareX = useCallback(() => {
    const url = `https://x.com/intent/tweet?text=${encodeURIComponent(
      shareText,
    )}&url=${encodeURIComponent(profileUrl)}`;
    track("profile_share", { handle, target: "x" });
    window.open(url, "_blank", "noopener,noreferrer,width=560,height=540");
    setOpen(false);
  }, [handle, profileUrl, shareText]);

  const onShareLinkedIn = useCallback(() => {
    const url = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
      profileUrl,
    )}`;
    track("profile_share", { handle, target: "linkedin" });
    window.open(url, "_blank", "noopener,noreferrer,width=620,height=600");
    setOpen(false);
  }, [handle, profileUrl]);

  const onShareNative = useCallback(async () => {
    if (typeof navigator === "undefined" || !("share" in navigator)) return;
    try {
      await (
        navigator as Navigator & {
          share: (data: ShareData) => Promise<void>;
        }
      ).share({
        title: `${shareLabel} — Petdex`,
        text: shareText,
        url: profileUrl,
      });
      track("profile_share", { handle, target: "native" });
      setOpen(false);
    } catch {
      /* user cancelled */
    }
  }, [handle, profileUrl, shareLabel, shareText]);

  const supportsNative =
    typeof navigator !== "undefined" && "share" in navigator;

  const menuNode =
    open && menuPos ? (
      <div
        ref={menuRef}
        role="menu"
        style={{ position: "fixed", top: menuPos.top, left: menuPos.left }}
        className="z-[100] w-64 overflow-hidden rounded-2xl border border-border-base bg-surface shadow-xl shadow-blue-950/15"
      >
        <div className="flex items-center justify-between border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.06]">
          <span className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
            {t("eyebrow")}
          </span>
          <button
            type="button"
            aria-label={t("close")}
            onClick={() => setOpen(false)}
            className="grid size-6 place-items-center rounded-full text-muted-4 transition hover:bg-surface-muted hover:text-foreground"
          >
            <CloseIcon className="size-3.5" />
          </button>
        </div>
        <ul className="py-1">
          <li>
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.preventDefault();
                void onCopy();
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-muted-2 transition hover:bg-surface-muted hover:text-foreground"
            >
              {copied ? (
                <Check className="size-4 text-emerald-600" />
              ) : (
                <Link2 className="size-4" />
              )}
              <span className="flex flex-col">
                <span>{copied ? t("copied") : t("copyLink")}</span>
                <span className="font-mono text-[10px] tracking-tight text-muted-4">
                  {profileUrl.replace(/^https?:\/\//, "")}
                </span>
              </span>
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.preventDefault();
                onShareX();
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-muted-2 transition hover:bg-surface-muted hover:text-foreground"
            >
              <XIcon className="size-4" />
              <span>{t("shareToX")}</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.preventDefault();
                onShareLinkedIn();
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-muted-2 transition hover:bg-surface-muted hover:text-foreground"
            >
              <LinkedInIcon className="size-4" />
              <span>{t("shareToLinkedIn")}</span>
            </button>
          </li>
          {supportsNative ? (
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.preventDefault();
                  void onShareNative();
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-muted-2 transition hover:bg-surface-muted hover:text-foreground"
              >
                <Share2 className="size-4" />
                <span>{t("more")}</span>
              </button>
            </li>
          ) : null}
        </ul>
      </div>
    ) : null;

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
        className="inline-flex h-10 items-center gap-2 rounded-full border border-border-base bg-surface px-4 text-sm font-medium text-muted-2 transition hover:border-border-strong hover:text-foreground"
      >
        <Share2 className="size-4" />
        {t("share")}
      </button>
      {mounted && menuNode ? createPortal(menuNode, document.body) : null}
    </div>
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
