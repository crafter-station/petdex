// Server-side: PETDEX_ADMIN_USER_IDS (private env). Authoritative for any
// gate that actually performs an admin action.
export function getAdminUserIds(): Set<string> {
  const raw = process.env.PETDEX_ADMIN_USER_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isAdmin(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return getAdminUserIds().has(userId);
}

// Client-safe: NEXT_PUBLIC_PETDEX_ADMIN_USER_IDS gives the same list to the
// browser bundle so client components (e.g. UserButton menu) can decide
// whether to show admin links. Visibility-only — every server route that
// mutates state still re-checks via isAdmin().
export function getPublicAdminUserIds(): Set<string> {
  const raw = process.env.NEXT_PUBLIC_PETDEX_ADMIN_USER_IDS ?? "";
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function isAdminClientSafe(
  userId: string | null | undefined,
): boolean {
  if (!userId) return false;
  return getPublicAdminUserIds().has(userId);
}
