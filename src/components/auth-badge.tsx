"use client";

import Image from "next/image";
import Link from "next/link";

import { SignInButton, useAuth, useClerk, useUser } from "@clerk/nextjs";
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

import { isAdminClientSafe } from "@/lib/admin";
import { withLocale } from "@/lib/locale-routing";
import { cn } from "@/lib/utils";

import { useHeaderState } from "@/components/header-state-provider";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { NotificationsBell } from "@/components/notifications-bell";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { hasLocale, type Locale } from "@/i18n/config";

export function AuthBadge({ compact = false }: { compact?: boolean }) {
  const { isLoaded, isSignedIn } = useAuth();

  return (
    <div className="flex items-center gap-2">
      {!isLoaded ? (
        // While Clerk hydrates, reserve space for the largest possible
        // signed-in slot (bell + avatar) so the rest of the header
        // doesn't shift when auth resolves.
        <>
          <BellSkeleton compact={compact} />
          <AvatarSkeleton compact={compact} />
        </>
      ) : isSignedIn ? (
        <>
          <NotificationsBell compact={compact} />
          <UserDropdown compact={compact} />
        </>
      ) : (
        <SignInButton mode="modal">
          <Button
            variant="petdex-pill"
            type="button"
            className={cn(
              "px-4 font-medium transition-[height,font-size] duration-200",
              compact ? "h-9 text-xs" : "h-11 text-sm",
            )}
          >
            Sign in
          </Button>
        </SignInButton>
      )}
    </div>
  );
}

function BellSkeleton({ compact }: { compact: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-pulse rounded-full border border-border-base bg-surface-muted/60 transition-[width,height] duration-200",
        compact ? "size-9" : "size-11",
      )}
    />
  );
}

function UserDropdown({ compact = false }: { compact?: boolean }) {
  const { user, isLoaded } = useUser();
  const { signOut, openUserProfile } = useClerk();
  const showAdmin = isAdminClientSafe(user?.id);
  const unread = useHeaderState().state.feedback.count;
  const t = useTranslations("header");
  const locale = useLocale();
  const currentLocale: Locale = hasLocale(locale) ? locale : "en";
  const href = (pathname: string) => withLocale(pathname, currentLocale);

  if (!isLoaded || !user) {
    return <AvatarSkeleton compact={compact} />;
  }

  const handle = user.username
    ? user.username.toLowerCase()
    : user.id.slice(-8).toLowerCase();
  const avatarUrl = user.imageUrl;
  const displayName =
    user.fullName || user.username || user.primaryEmailAddress?.emailAddress;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Open user menu"
            className={cn(
              "group/avatar relative grid place-items-center overflow-hidden rounded-full ring-1 ring-foreground/10 transition-[width,height] duration-200 hover:ring-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none data-popup-open:ring-foreground/30",
              compact ? "size-9" : "size-11",
            )}
          />
        }
      >
        <Image
          src={avatarUrl}
          alt={displayName ?? "User avatar"}
          width={44}
          height={44}
          className="size-full object-cover"
        />
        {unread > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-brand font-mono text-[9px] font-semibold text-white ring-2 ring-surface"
          >
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={8} className="w-64 p-1.5">
        {displayName ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel className="px-3 py-2">
              <div className="truncate text-sm font-medium text-foreground">
                {displayName}
              </div>
              {user.primaryEmailAddress?.emailAddress &&
              user.primaryEmailAddress.emailAddress !== displayName ? (
                <div className="truncate text-xs text-muted-3">
                  {user.primaryEmailAddress.emailAddress}
                </div>
              ) : null}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
        ) : null}

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link href={`/u/${handle}`} />}>
            <IdentificationCardIcon weight="duotone" className="size-4" />
            My profile
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href="/my-feedback" />}>
            <ChatCircleDotsIcon weight="duotone" className="size-4" />
            My feedback
            {unread > 0 ? (
              <span className="ml-auto rounded-full bg-brand-tint px-1.5 py-0.5 font-mono text-[9px] font-semibold text-brand dark:bg-brand-tint-dark">
                {unread > 9 ? "9+" : unread}
              </span>
            ) : null}
          </DropdownMenuItem>
          {showAdmin ? (
            <DropdownMenuItem render={<Link href="/admin" />}>
              <ShieldCheckIcon weight="duotone" className="size-4" />
              Admin
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link href={href("/about")} />}>
            <InfoIcon weight="duotone" className="size-4" />
            {t("about")}
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link href={href("/legal/takedown")} />}>
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
          <DropdownMenuItem onClick={() => openUserProfile()}>
            <GearSixIcon weight="duotone" className="size-4" />
            Manage account
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => signOut({ redirectUrl: "/" })}>
            <SignOutIcon weight="duotone" className="size-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AvatarSkeleton({ compact = false }: { compact?: boolean }) {
  return (
    <div
      aria-hidden
      className={cn(
        "animate-pulse rounded-full bg-surface-muted ring-1 ring-foreground/10 transition-[width,height] duration-200",
        compact ? "size-9" : "size-11",
      )}
    />
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
