import { notFound } from "next/navigation";

import { auth } from "@clerk/nextjs/server";

import { isCollaborator } from "@/lib/admin";

import { PendingEditsReviewPage } from "@/components/pending-edits-review-page";

export const metadata = {
  title: "Petdex Collaborator · Edits",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function CollaboratorEditsPage() {
  const { userId } = await auth();
  if (!isCollaborator(userId)) notFound();

  return <PendingEditsReviewPage actionScope="collaborator" />;
}
