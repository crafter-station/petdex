import { redirect } from "next/navigation";

import { auth } from "@clerk/nextjs/server";
import { getTranslations } from "next-intl/server";

import { handleForUser } from "@/lib/handles";
import { withLocale } from "@/lib/locale-routing";

import type { Locale } from "@/i18n/config";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "myPets" });
  return {
    title: t("metadataTitle"),
    robots: { index: false, follow: false },
  };
}

export default async function MyPetsRedirectPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const localeValue = locale as Locale;
  const { userId, redirectToSignIn } = await auth();

  if (!userId) {
    return redirectToSignIn({
      returnBackUrl: withLocale("/my-pets", localeValue),
    });
  }

  const handle = await handleForUser(userId);
  redirect(withLocale(`/u/${encodeURIComponent(handle)}#pets`, localeValue));
}
