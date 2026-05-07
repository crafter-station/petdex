import { eq } from "drizzle-orm";

import { defaultLocale, hasLocale, type Locale } from "@/i18n/config";
import { db, schema } from "@/lib/db/client";

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
