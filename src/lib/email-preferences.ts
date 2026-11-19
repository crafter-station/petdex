import "server-only";

import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";

export type EmailPreference = typeof schema.emailPreferences.$inferSelect;

export function newUnsubscribeToken(): string {
  return `mlu_${crypto.randomUUID().replace(/-/g, "")}${crypto
    .randomUUID()
    .replace(/-/g, "")
    .slice(0, 12)}`;
}

// NUL is the one control character Postgres rejects outright in a `text`
// column — `invalid byte sequence for encoding "UTF8": 0x00`. The same
// guard already exists on the pet-requests query (which answers 400); the
// unsubscribe token comparison had it missing, so `?token=a%00b` reached
// the driver from a public, unauthenticated page and 500'd. The other C0
// controls pass through fine and are left alone.
function isUnqueryableToken(token: string): boolean {
  return token.includes("\u0000");
}

export async function findByToken(
  token: string,
): Promise<EmailPreference | null> {
  if (isUnqueryableToken(token)) return null;
  const rows = await db
    .select()
    .from(schema.emailPreferences)
    .where(eq(schema.emailPreferences.unsubscribeToken, token))
    .limit(1);
  return rows[0] ?? null;
}

export async function markUnsubscribed(token: string): Promise<boolean> {
  if (isUnqueryableToken(token)) return false;
  const result = await db
    .update(schema.emailPreferences)
    .set({
      unsubscribedMarketing: true,
      unsubscribedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.emailPreferences.unsubscribeToken, token))
    .returning({ userId: schema.emailPreferences.userId });
  return result.length > 0;
}

export async function markResubscribed(token: string): Promise<boolean> {
  if (isUnqueryableToken(token)) return false;
  const result = await db
    .update(schema.emailPreferences)
    .set({
      unsubscribedMarketing: false,
      unsubscribedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.emailPreferences.unsubscribeToken, token))
    .returning({ userId: schema.emailPreferences.userId });
  return result.length > 0;
}
