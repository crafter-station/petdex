"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";

import { SignInButton, useAuth, useClerk, useUser } from "@clerk/nextjs";
import { useTranslations } from "next-intl";

import { isAdminClientSafe } from "@/lib/admin";
import { cn } from "@/lib/utils";

import { useAuthIntent } from "@/components/auth-intent";
import { useHeaderState } from "@/components/header-state-provider";
import { NotificationsBell } from "@/components/notifications-bell";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { UserDropdownContentProps } from "@/components/user-dropdown-content";

function loadUserDropdownContent() {
  return import("@/components/user-dropdown-content");
}

function preloadUserDropdownContent() {
  void loadUserDropdownContent();
}

const UserDropdownContent = dynamic<UserDropdownContentProps>(
  () => loadUserDropdownContent().then((mod) => mod.UserDropdownContent),
  {
    loading: UserDropdownContentLoading,
    ssr: false,
  },
);

export function AuthBadge({ compact = false }: { compact?: boolean }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { openSignIn } = useClerk();
  const { consumeAuthIntent, intentVersion } = useAuthIntent();
  const t = useTranslations("header");

  useEffect(() => {
    if (!isLoaded || isSignedIn || intentVersion === 0) return;
    consumeAuthIntent(intentVersion);
    openSignIn();
  }, [consumeAuthIntent, intentVersion, isLoaded, isSignedIn, openSignIn]);

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
            {t("signIn")}
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
  const headerState = useHeaderState().state;
  const unread = headerState.feedback.count;
  const dbHandle = headerState.profile?.handle ?? null;
  const t = useTranslations("header");
  const [menuOpen, setMenuOpen] = useState(false);
  const adminHref =
    process.env.NEXT_PUBLIC_PETDEX_ADMIN_URL?.replace(/\/$/, "") ||
    "https://admin.petdex.dev";
  const handleManageAccount = useCallback(() => {
    openUserProfile();
  }, [openUserProfile]);
  const handleSignOut = useCallback(() => {
    void signOut({ redirectUrl: "/" });
  }, [signOut]);

  if (!isLoaded || !user) {
    return <AvatarSkeleton compact={compact} />;
  }

  const handle =
    dbHandle ??
    (user.username
      ? user.username.toLowerCase()
      : user.id.slice(-8).toLowerCase());
  const avatarUrl = user.imageUrl;
  const displayName =
    user.fullName || user.username || user.primaryEmailAddress?.emailAddress;
  const email = user.primaryEmailAddress?.emailAddress ?? null;

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t("openUserMenu")}
            onFocus={preloadUserDropdownContent}
            onPointerEnter={preloadUserDropdownContent}
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
        {menuOpen ? (
          <UserDropdownContent
            adminHref={adminHref}
            displayName={displayName ?? null}
            email={email}
            handle={handle}
            onManageAccount={handleManageAccount}
            onSignOut={handleSignOut}
            showAdmin={showAdmin}
            unread={unread}
          />
        ) : null}
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

function UserDropdownContentLoading() {
  return (
    <div aria-hidden="true" className="space-y-1 p-2">
      <div className="mb-2 space-y-1 px-1">
        <div className="h-4 w-28 animate-pulse rounded bg-surface-muted" />
        <div className="h-3 w-36 animate-pulse rounded bg-surface-muted/80" />
      </div>
      <div className="h-px bg-border-base" />
      <div className="h-8 animate-pulse rounded-xl bg-surface-muted/70" />
      <div className="h-8 animate-pulse rounded-xl bg-surface-muted/70" />
      <div className="h-px bg-border-base" />
      <div className="h-8 animate-pulse rounded-xl bg-surface-muted/70" />
      <div className="h-8 animate-pulse rounded-xl bg-surface-muted/70" />
    </div>
  );
}
