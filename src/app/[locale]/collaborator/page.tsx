import { notFound } from "next/navigation";

import { auth } from "@clerk/nextjs/server";

import { isCollaborator } from "@/lib/admin";

import {
  SubmissionReviewQueue,
  type SubmissionReviewQueueSearchParams,
} from "@/components/submission-review-queue";

export const metadata = {
  title: "Petdex Collaborator",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function CollaboratorPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SubmissionReviewQueueSearchParams>;
}) {
  const { userId } = await auth();
  if (!isCollaborator(userId)) notFound();

  const { locale } = await params;
  const resolvedSearchParams = await searchParams;
  return (
    <SubmissionReviewQueue
      locale={locale}
      searchParams={resolvedSearchParams}
      actionScope="collaborator"
    />
  );
}
