"use client";

import Link from "next/link";

import {
  GearSixIcon,
  IdentificationCardIcon,
  InfoIcon,
  ShieldCheckIcon,
  ShieldWarningIcon,
  SignOutIcon,
} from "@phosphor-icons/react";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/ssr";
import { ExternalLink } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { withLocale } from "@/lib/locale-routing";

import { LocaleSwitcher } from "@/components/locale-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

import { hasLocale, type Locale } from "@/i18n/config";

export type UserDropdownContentProps = {
  adminHref: string;
  displayName: string | null;
  email: string | null;
  handle: string;
  onManageAccount: () => void;
  onSignOut: () => void;
  showAdmin: boolean;
  unread: number;
};

export function UserDropdownContent({
  adminHref,
  displayName,
  email,
  handle,
  onManageAccount,
  onSignOut,
  showAdmin,
  unread,
}: UserDropdownContentProps) {
  const t = useTranslations("header");
  const locale = useLocale();
  const currentLocale: Locale = hasLocale(locale) ? locale : "en";
  const href = (pathname: string) => withLocale(pathname, currentLocale);

  return (
    <>
      {displayName ? (
        <DropdownMenuGroup>
          <DropdownMenuLabel className="px-3 py-2">
            <div className="truncate text-sm font-medium text-foreground">
              {displayName}
            </div>
            {email && email !== displayName ? (
              <div className="truncate text-xs text-muted-3">{email}</div>
            ) : null}
          </DropdownMenuLabel>
        </DropdownMenuGroup>
      ) : null}

      <DropdownMenuSeparator />

      <DropdownMenuGroup>
        <DropdownMenuItem
          render={<Link href={`/u/${handle}`} prefetch={false} />}
        >
          <IdentificationCardIcon weight="duotone" className="size-4" />
          {t("myProfile")}
        </DropdownMenuItem>
        <DropdownMenuItem
          render={<Link href="/my-feedback" prefetch={false} />}
        >
          <ChatCircleDotsIcon weight="duotone" className="size-4" />
          {t("myFeedback")}
          {unread > 0 ? (
            <span className="ml-auto rounded-full bg-brand-tint px-1.5 py-0.5 font-mono text-[9px] font-semibold text-brand dark:bg-brand-tint-dark">
              {unread > 9 ? "9+" : unread}
            </span>
          ) : null}
        </DropdownMenuItem>
        {showAdmin ? (
          <DropdownMenuItem render={<Link href={adminHref} prefetch={false} />}>
            <ShieldCheckIcon weight="duotone" className="size-4" />
            {t("admin")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuGroup>

      <DropdownMenuSeparator />

      <DropdownMenuGroup>
        <DropdownMenuItem
          render={<Link href={href("/about")} prefetch={false} />}
        >
          <InfoIcon weight="duotone" className="size-4" />
          {t("about")}
        </DropdownMenuItem>
        <DropdownMenuItem
          render={<Link href={href("/legal/takedown")} prefetch={false} />}
        >
          <ShieldWarningIcon weight="duotone" className="size-4" />
          {t("takedown")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            window.open(
              "https://x.com/raillyhugo",
              "_blank",
              "noopener,noreferrer",
            )
          }
          className="justify-between"
        >
          <span className="inline-flex items-center gap-2">
            <XLogo className="size-3.5 text-muted-3" />
            {t("followOnX")}
          </span>
          <ExternalLink className="size-3.5 text-muted-4" />
        </DropdownMenuItem>
      </DropdownMenuGroup>

      <DropdownMenuSeparator />

      <DropdownMenuGroup>
        <DropdownMenuLabel className="px-3 pt-1 pb-1.5 font-mono text-[10px] tracking-[0.18em] text-muted-3 uppercase">
          {t("settings")}
        </DropdownMenuLabel>
        <div className="flex items-center gap-2 px-2 pb-1">
          <ThemeToggle />
          <LocaleSwitcher />
        </div>
      </DropdownMenuGroup>

      <DropdownMenuSeparator />

      <DropdownMenuGroup>
        <DropdownMenuItem onClick={onManageAccount}>
          <GearSixIcon weight="duotone" className="size-4" />
          {t("manageAccount")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onSignOut}>
          <SignOutIcon weight="duotone" className="size-4" />
          {t("signOut")}
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  );
}

function XLogo({ className }: { className?: string }) {
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
