"use client";

import { useRef } from "react";

import { HeaderNavLink } from "@/components/site-header/header-nav-link";
import { MobileHeaderSettings } from "@/components/site-header/mobile-header-settings";
import { SubmitLink } from "@/components/site-header/submit-link";
import type { HeaderNavItem } from "@/components/site-header/types";

const menuLinkClassName =
  "flex rounded-xl px-3 py-2.5 text-sm font-medium text-foreground transition hover:bg-surface-muted";

type MobileNavProps = {
  items: HeaderNavItem[];
  githubItem: HeaderNavItem;
  submitHref: string;
  submitLabel: string;
  openMenuLabel: string;
  hideSubmitCta: boolean;
};

export function MobileNav({
  items,
  githubItem,
  submitHref,
  submitLabel,
  openMenuLabel,
  hideSubmitCta,
}: MobileNavProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  // A native <details> ignores Escape, so the open menu could only be closed
  // by clicking the summary again, and focus was left wherever it was. Close
  // it and hand focus back to the trigger.
  function closeOnEscape(event: React.KeyboardEvent<HTMLDetailsElement>) {
    const details = detailsRef.current;
    if (event.key !== "Escape" || !details?.open) return;
    event.stopPropagation();
    details.open = false;
    details.querySelector("summary")?.focus();
  }

  // HeaderNavLink navigates with next/link, which re-renders the page in
  // place — the layout (and this <details>) survives, so the menu stayed
  // open over the new page. Clicking anything inside the menu means
  // "leave", so close it on capture before the router takes over.
  function closeOnNavigate(event: React.MouseEvent<HTMLDetailsElement>) {
    const details = detailsRef.current;
    if (!details?.open) return;
    const target = event.target as HTMLElement;
    if (!target.closest("a[href]")) return;
    details.open = false;
  }

  return (
    <details
      ref={detailsRef}
      onKeyDown={closeOnEscape}
      onClickCapture={closeOnNavigate}
      className="group relative xl:hidden"
    >
      <summary
        aria-label={openMenuLabel}
        className="grid size-10 cursor-pointer list-none place-items-center rounded-full border border-border-base bg-surface/70 text-muted-2 transition hover:bg-surface hover:text-foreground [&::-webkit-details-marker]:hidden"
      >
        <span className="flex flex-col gap-1.5" aria-hidden="true">
          <span className="h-0.5 w-4 rounded-full bg-current" />
          <span className="h-0.5 w-4 rounded-full bg-current" />
        </span>
      </summary>
      <div className="absolute top-12 right-0 z-50 w-[min(280px,calc(100vw-2rem))] rounded-2xl border border-border-base bg-surface p-2 shadow-xl shadow-blue-950/15">
        {items.map((item) => (
          <HeaderNavLink
            key={item.href}
            item={item}
            className={menuLinkClassName}
          />
        ))}
        <HeaderNavLink item={githubItem} className={menuLinkClassName} />
        {hideSubmitCta ? null : (
          <SubmitLink href={submitHref} label={submitLabel} variant="mobile" />
        )}
        <MobileHeaderSettings />
      </div>
    </details>
  );
}
