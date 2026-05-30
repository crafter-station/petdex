import { getTranslations } from "next-intl/server";

import {
  SubmissionReviewQueue,
  type SubmissionReviewQueueSearchParams,
} from "@/components/submission-review-queue";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "admin.metadata" });

  return {
    title: t("title"),
    robots: { index: false, follow: false },
  };
}

export const dynamic = "force-dynamic";

export default async function AdminPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<SubmissionReviewQueueSearchParams>;
}) {
  const { locale } = await params;
  const resolvedSearchParams = await searchParams;
  return (
    <SubmissionReviewQueue
      locale={locale}
      searchParams={resolvedSearchParams}
    />
  );
}
