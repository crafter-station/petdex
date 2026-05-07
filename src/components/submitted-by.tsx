"use client";

import Link from "next/link";

import { useTranslations } from "next-intl";

import type { OwnerCredit } from "@/lib/owner-credit";
import { isAllowedAvatarUrl } from "@/lib/url-allowlist";

type SubmittedByProps = {
  credit: OwnerCredit;
};

// Inline brand glyphs — lucide-react dropped GitHub and never shipped X
// because brand assets aren't FOSS. Keep them tiny and currentColor so
// they style with the surrounding chip.
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <title>GitHub</title>
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.69.08-.69 1.15.08 1.76 1.18 1.76 1.18 1.02 1.76 2.69 1.25 3.34.95.1-.74.4-1.25.72-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18.92-.26 1.91-.39 2.89-.39.98 0 1.97.13 2.89.39 2.21-1.49 3.18-1.18 3.18-1.18.62 1.58.23 2.75.11 3.04.74.81 1.18 1.84 1.18 3.1 0 4.42-2.7 5.4-5.27 5.68.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.68.8.56C20.21 21.39 23.5 17.08 23.5 12 23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

function XIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <title>X</title>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function SubmittedBy({ credit }: SubmittedByProps) {
  const t = useTranslations("submittedBy");
  const showAvatar = credit.imageUrl && isAllowedAvatarUrl(credit.imageUrl);
  const profileHref = `/u/${credit.handle}`;

  return (
    <Link
      href={profileHref}
      aria-label={t("viewProfile", { name: credit.name })}
      className="group block rounded-2xl border border-border-base bg-surface/76 p-4 backdrop-blur transition hover:border-border-strong hover:bg-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      <div className="flex items-center gap-3">
        {showAvatar ? (
          // biome-ignore lint/performance/noImgElement: external avatar URL
          <img
            src={credit.imageUrl ?? undefined}
            alt=""
            className="size-10 shrink-0 rounded-full ring-1 ring-border-base"
          />
        ) : (
          <div className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-muted font-mono text-sm text-muted-2 ring-1 ring-border-base">
            {credit.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
            {t("eyebrow")}
          </p>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <p className="truncate text-sm font-medium text-foreground">
              {credit.name}
            </p>
            {credit.username ? (
              <p className="font-mono text-[11px] text-muted-4">
                @{credit.username}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {credit.externals.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border-base pt-3">
          {credit.externals.map((ext) => (
            // Rendered as a button (not nested <a>, which would be
            // invalid HTML inside the wrapping profile <Link>). The
            // button calls window.open and stops propagation so the
            // outer card click doesn't also fire.
            <button
              key={ext.url}
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                window.open(ext.url, "_blank", "noopener,noreferrer");
              }}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border-base bg-surface px-2.5 font-mono text-[11px] tracking-[0.04em] text-muted-2 transition hover:border-border-strong hover:bg-surface-muted"
            >
              {ext.provider === "github" ? (
                <GithubIcon className="size-3.5" />
              ) : (
                <XIcon className="size-3" />
              )}
              {ext.username}
            </button>
          ))}
        </div>
      ) : null}
    </Link>
  );
}
