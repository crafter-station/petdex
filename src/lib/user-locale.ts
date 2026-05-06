import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";

import { defaultLocale, hasLocale, type Locale } from "@/i18n/config";

export async function getPreferredLocaleForUser(
  userId: string | null | undefined,
): Promise<Locale> {
  if (!userId) return defaultLocale;

  const profile = await db.query.userProfiles.findFirst({
    columns: { preferredLocale: true },
    where: eq(schema.userProfiles.userId, userId),
  });

  if (profile?.preferredLocale && hasLocale(profile.preferredLocale)) {
    return profile.preferredLocale;
  }

  return defaultLocale;
}
