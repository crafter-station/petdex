"use client";

import { SignInButton, useUser } from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";
import { useTranslations } from "next-intl";

// Inline "Is this you?" prompt shown on /pets/[slug] for discovered
// pets when the viewer is either signed-out or signed in as someone
// other than the listed author. Pushes them to sign in with the
// expectation that the claim banner on /u/<handle> will pick the row
// up automatically (case-insensitive github match landed earlier).
export function ClaimCTA({
  petName,
  authorLabel,
  githubUrl,
}: {
  petName: string;
  authorLabel: string;
  githubUrl: string | null;
}) {
  const t = useTranslations("claim");
  const { isLoaded, isSignedIn, user } = useUser();
  if (!isLoaded) return null;

  // If signed in and the viewer's github already matches, hide. The
  // banner on /u/<handle> will surface the actual claim button there.
  // We only check github match here — if their email matches but no
  // github linked, the banner still shows so they're nudged into
  // adding GitHub OAuth which makes the claim cleaner.
  if (isSignedIn && githubUrl && user) {
    const externals = (user.externalAccounts ?? []) as Array<{
      provider?: string;
      username?: string;
    }>;
    const myGh = externals.find((a) => a.provider === "oauth_github")?.username;
    if (myGh) {
      const myGhUrl = `https://github.com/${myGh}`.toLowerCase();
      if (myGhUrl === githubUrl.toLowerCase()) return null;
    }
  }

  const inner = (
    <span className="inline-flex h-10 items-center gap-1.5 rounded-full bg-inverse px-4 text-sm font-medium text-on-inverse transition hover:bg-inverse-hover">
      {t("cta")}
      <ArrowRight className="size-4" />
    </span>
  );

  return (
    <aside className="mt-3 flex flex-wrap items-center gap-3 rounded-2xl border border-chip-warning-fg/30 bg-chip-warning-bg p-4 text-sm text-chip-warning-fg">
      <span className="flex-1 leading-6">
        {t.rich("body", {
          author: authorLabel,
          petName,
          strong: (chunks) => (
            <strong className="font-semibold">{chunks}</strong>
          ),
        })}
      </span>
      {isSignedIn ? (
        // Already signed in — send them to their own profile where the
        // claim banner inside ProfileTabs does the actual transfer.
        <a href={profileHrefForUser(user)} className="inline-flex">
          {inner}
        </a>
      ) : (
        <SignInButton mode="modal" forceRedirectUrl="/" fallbackRedirectUrl="/">
          <button type="button" className="inline-flex">
            {inner}
          </button>
        </SignInButton>
      )}
    </aside>
  );
}

function profileHrefForUser(
  user: { username?: string | null; id: string } | null | undefined,
): string {
  if (!user) return "/";
  const handle = user.username
    ? user.username.toLowerCase()
    : user.id.slice(-8).toLowerCase();
  return `/u/${handle}`;
}
