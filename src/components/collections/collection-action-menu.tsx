"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import {
  Check,
  Copy,
  ExternalLink,
  Layers,
  Link2,
  MoreHorizontal,
  Terminal,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import {
  buildDownloadInstallNext,
  buildPetdexInstallUrl,
  openPetdexDeepLink,
} from "@/lib/petdex-desktop-link";
import { usePlatform } from "@/lib/use-platform";

import { CodexLogo } from "@/components/download/codex-logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { localizePath } from "@/i18n/config";

const SITE_URL = "https://petdex.dev";
// Cap on the install command length. Beyond this we truncate with a
// hint so the user can paste the rest manually instead of getting a
// 4 KB clipboard payload that some shells reject.
const MAX_SLUGS_IN_COMMAND = 24;

type CollectionPet = { slug: string };

type Props = {
  collection: {
    slug: string;
    title: string;
    petCount: number;
    pets: CollectionPet[];
  };
};

type Copied = "install" | "link" | null;

export function CollectionActionMenu({ collection }: Props) {
  const t = useTranslations("collectionActionMenu");
  const locale = useLocale();
  const [copied, setCopied] = useState<Copied>(null);
  const platform = usePlatform();
  // Every desktop host answers petdex:// now, so the batch-install entry
  // is no longer macOS-only. Phones and tablets stay out: usePlatform
  // buckets them separately and no build runs there.
  const isDesktop =
    platform === "macos" || platform === "linux" || platform === "windows";

  // Auto-clear the copied affordance so a user reopening the menu later
  // does not see a stale checkmark.
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(null), 1600);
    return () => window.clearTimeout(id);
  }, [copied]);

  const slugs = collection.pets.map((p) => p.slug);
  const truncated = slugs.length > MAX_SLUGS_IN_COMMAND;
  const installSlugs = truncated ? slugs.slice(0, MAX_SLUGS_IN_COMMAND) : slugs;
  const installCmd = `npx petdex install ${installSlugs.join(" ")}`;
  const petdexInstallUrl = buildPetdexInstallUrl(installSlugs);
  const downloadHref = `${localizePath(locale, "/download")}?next=${encodeURIComponent(buildDownloadInstallNext(installSlugs))}`;
  const collectionUrl = `${SITE_URL}/collections/${collection.slug}`;
  const installHint = truncated
    ? t("installHintTruncated", {
        shown: installSlugs.length,
        total: slugs.length,
      })
    : t("installHint", { count: slugs.length });
  const openInPetdexDesc = truncated ? installHint : t("openInPetdexDesc");

  const copyText = async (text: string, kind: Exclude<Copied, null>) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
    } catch {
      /* clipboard blocked: fail silent, no toast infra here */
    }
  };

  const onShareX = () => {
    const text = t("shareXText", { title: collection.title });
    const url = `https://x.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(collectionUrl)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation wrapper, the trigger button is the interactive role
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") e.stopPropagation();
      }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={t("moreActions", { title: collection.title })}
          className="inline-flex size-8 items-center justify-center rounded-full border border-border-base bg-surface/70 text-muted-2 backdrop-blur transition hover:bg-surface-muted hover:text-foreground data-popup-open:bg-surface-muted data-popup-open:text-foreground"
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className="w-72 p-0">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex items-center gap-1.5 border-b border-foreground/[0.06] px-3 py-2 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
              <Layers className="size-3" />
              {collection.title}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          {slugs.length > 0 && isDesktop ? (
            <DropdownMenuItem
              render={
                // biome-ignore lint/a11y/useAnchorContent: content injected by the render prop
                <a href={downloadHref} />
              }
              onClick={(e) => {
                const me = e as unknown as React.MouseEvent;
                if (me.metaKey || me.ctrlKey || me.shiftKey) return;
                me.preventDefault?.();
                openPetdexDeepLink(petdexInstallUrl, downloadHref);
              }}
            >
              <Image
                src="/brand/petdex-desktop-icon.png"
                alt=""
                width={16}
                height={16}
                className="size-4 object-contain"
              />
              <span className="flex flex-col">
                <span>{t("openInPetdex")}</span>
                <span className="font-mono text-[10px] tracking-tight text-muted-4">
                  {openInPetdexDesc}
                </span>
              </span>
            </DropdownMenuItem>
          ) : null}
          {slugs.length > 0 ? (
            <DropdownMenuItem
              render={
                // biome-ignore lint/a11y/useAnchorContent: content injected by the render prop
                <a
                  href={`codex://new?prompt=${encodeURIComponent(`Install this Petdex collection by running: ${installCmd}`)}`}
                />
              }
            >
              <CodexLogo className="size-4" />
              <span className="flex flex-col">
                <span>{t("openInCodex")}</span>
                <span className="font-mono text-[10px] tracking-tight text-muted-4">
                  {t("openInCodexDesc")}
                </span>
              </span>
            </DropdownMenuItem>
          ) : null}
          {slugs.length > 0 ? (
            <DropdownMenuItem
              closeOnClick={false}
              onClick={() => void copyText(installCmd, "install")}
            >
              {copied === "install" ? (
                <Check className="size-4 text-emerald-600" />
              ) : (
                <Terminal className="size-4" />
              )}
              <span className="flex flex-col">
                <span>
                  {copied === "install"
                    ? t("copiedInstall")
                    : t("copyInstallAll")}
                </span>
                <span className="font-mono text-[10px] tracking-tight text-muted-4">
                  {installHint}
                </span>
              </span>
              {copied !== "install" ? (
                <Copy className="ml-auto size-3.5 text-muted-4" />
              ) : null}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            closeOnClick={false}
            onClick={() => void copyText(collectionUrl, "link")}
          >
            {copied === "link" ? (
              <Check className="size-4 text-emerald-600" />
            ) : (
              <Link2 className="size-4" />
            )}
            <span className="flex flex-col">
              <span>
                {copied === "link" ? t("copiedLink") : t("copyCollectionLink")}
              </span>
              <span className="font-mono text-[10px] tracking-tight text-muted-4">
                {collectionUrl.replace(/^https?:\/\//, "")}
              </span>
            </span>
            {copied !== "link" ? (
              <Copy className="ml-auto size-3.5 text-muted-4" />
            ) : null}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onShareX}>
            <XIcon className="size-4" />
            {t("shareToX")}
          </DropdownMenuItem>
          <DropdownMenuSeparator className="my-0" />
          <DropdownMenuItem
            render={
              // biome-ignore lint/a11y/useAnchorContent: content injected by the render prop
              <a href={`/collections/${collection.slug}`} />
            }
          >
            <ExternalLink className="size-4" />
            <span className="flex-1">{t("viewCollection")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
