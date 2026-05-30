import { notFound } from "next/navigation";

import { auth } from "@clerk/nextjs/server";

import { canModeratePublishedPets } from "@/lib/admin";

import {
  PublishedPetModerationPage,
  type PublishedPetModerationSearchParams,
} from "@/components/published-pet-moderation-page";

export const metadata = {
  title: "Petdex Collaborator · Published moderation",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function CollaboratorModerationPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<PublishedPetModerationSearchParams>;
}) {
  const { userId } = await auth();
  if (!canModeratePublishedPets(userId)) notFound();

  const { locale } = await params;
  const resolvedSearchParams = await searchParams;
  return (
    <PublishedPetModerationPage
      locale={locale}
      searchParams={resolvedSearchParams}
    />
  );
}
