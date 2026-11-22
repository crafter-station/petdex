import { cn } from "@/lib/utils";

import { HeaderNavLink } from "@/components/site-header/header-nav-link";
import { MobileHeaderSettings } from "@/components/site-header/mobile-header-settings";
import { SubmitLink } from "@/components/site-header/submit-link";
import type { HeaderNavItem } from "@/components/site-header/types";
import { buttonVariants } from "@/components/ui/button";

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
  return (
    <details className="group relative xl:hidden">
      <summary
        aria-label={openMenuLabel}
        className={cn(
          buttonVariants({
            variant: "petdex-pill",
            size: "icon-lg",
          }),
          "size-10 cursor-pointer list-none [&::-webkit-details-marker]:hidden",
        )}
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
