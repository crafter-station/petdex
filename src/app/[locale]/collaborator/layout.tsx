import { notFound } from "next/navigation";

import { auth } from "@clerk/nextjs/server";

import {
  canAccessCollaboratorArea,
  canEditWeChatQr,
  canModeratePublishedPets,
  isCollaborator,
} from "@/lib/admin";

import { CollaboratorTabs } from "@/components/collaborator-tabs";
import { SiteHeader } from "@/components/site-header";

export const metadata = {
  robots: { index: false, follow: false },
};

export default async function CollaboratorLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();
  if (!canAccessCollaboratorArea(userId)) notFound();
  const showReviewTabs = isCollaborator(userId);
  const showModerationTab = canModeratePublishedPets(userId);
  const showWeChatQrTab = canEditWeChatQr(userId);

  return (
    <main className="min-h-dvh bg-background text-foreground">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-5 py-5 md:px-8 md:py-6">
        <SiteHeader />
        <CollaboratorTabs
          showReviewTabs={showReviewTabs}
          showModerationTab={showModerationTab}
          showWeChatQrTab={showWeChatQrTab}
        />
      </section>
      {children}
    </main>
  );
}
