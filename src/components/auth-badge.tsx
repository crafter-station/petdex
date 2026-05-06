"use client";

import { SignInButton, UserButton, useAuth, useUser } from "@clerk/nextjs";
import { MessageSquare, Shield, UserSquare } from "lucide-react";

import { isAdminClientSafe } from "@/lib/admin";

import { useHeaderState } from "@/components/header-state-provider";
import { NotificationsBell } from "@/components/notifications-bell";

export function AuthBadge({ beforeUser }: { beforeUser?: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();

  if (!isLoaded || !isSignedIn) {
    return (
      <div className="flex items-center gap-2">
        {beforeUser}
        <SignInButton mode="modal">
          <button
            type="button"
            className="inline-flex h-11 items-center justify-center rounded-full border border-border-base bg-surface/70 px-4 text-sm font-medium text-foreground backdrop-blur transition hover:bg-white dark:hover:bg-stone-800"
          >
            Sign in
          </button>
        </SignInButton>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <NotificationsBell />
      {beforeUser}
      <UserButtonWithAdminLink />
    </div>
  );
}

function UserButtonWithAdminLink() {
  const { user } = useUser();
  // Visibility-only check; server still re-verifies admin actions via
  // isAdmin(). Tampering only exposes the entry, never escalates rights.
  const showAdmin = isAdminClientSafe(user?.id);
  const unread = useUnreadFeedback();
  // Mirror the server-side handle resolver: prefer Clerk username,
  // fall back to the last 8 chars of the userId so /u/<handle> always
  // points somewhere even when the user hasn't set a username.
  const handle = user?.username
    ? user.username.toLowerCase()
    : user?.id
      ? user.id.slice(-8).toLowerCase()
      : null;

  return (
    <div className="relative">
      <UserButton
        appearance={{
          elements: { avatarBox: "size-11 rounded-full ring-1 ring-black/10" },
        }}
      >
        <UserButton.MenuItems>
          {handle ? (
            <UserButton.Link
              label="My profile"
              labelIcon={<UserSquare className="size-4" />}
              href={`/u/${handle}`}
            />
          ) : null}
          <UserButton.Link
            label={unread > 0 ? `My feedback (${unread})` : "My feedback"}
            labelIcon={<MessageSquare className="size-4" />}
            href="/my-feedback"
          />
          {showAdmin ? (
            <UserButton.Link
              label="Admin"
              labelIcon={<Shield className="size-4" />}
              href="/admin"
            />
          ) : null}
        </UserButton.MenuItems>
      </UserButton>
      {unread > 0 ? (
        <span
          aria-hidden
          className="pointer-events-none absolute -top-0.5 -right-0.5 grid size-4 place-items-center rounded-full bg-brand font-mono text-[9px] font-semibold text-white ring-2 ring-white"
        >
          {unread > 9 ? "9+" : unread}
        </span>
      ) : null}
    </div>
  );
}

function useUnreadFeedback(): number {
  return useHeaderState().state.feedback.count;
}
