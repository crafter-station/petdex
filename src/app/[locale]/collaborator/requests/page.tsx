import { notFound } from "next/navigation";

import { auth } from "@clerk/nextjs/server";

import { isCollaborator } from "@/lib/admin";

import { PetRequestsReviewPage } from "@/components/pet-requests-review-page";

export const metadata = {
  title: "Petdex Collaborator · Requests",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function CollaboratorRequestsPage() {
  const { userId } = await auth();
  if (!isCollaborator(userId)) notFound();

  return <PetRequestsReviewPage actionScope="collaborator" />;
}
