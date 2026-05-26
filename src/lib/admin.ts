// Server-side: PETDEX_ADMIN_USER_IDS (private env). Authoritative for any
// gate that actually performs an admin action.
function parseUserIds(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function getAdminUserIds(): Set<string> {
  return parseUserIds(process.env.PETDEX_ADMIN_USER_IDS);
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
  return parseUserIds(process.env.NEXT_PUBLIC_PETDEX_ADMIN_USER_IDS);
}

export function isAdminClientSafe(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return getPublicAdminUserIds().has(userId);
}

const HENRY_USER_ID = process.env.HENRY_USER_ID;
const PUBLIC_HENRY_USER_ID = process.env.NEXT_PUBLIC_HENRY_USER_ID;

export function getCollaboratorUserIds(): Set<string> {
  return parseUserIds(process.env.PETDEX_COLLABORATOR_USER_IDS);
}

export function isCollaborator(userId: string | null | undefined): boolean {
  if (!userId) return false;
  if (isAdmin(userId)) return true;
  return getCollaboratorUserIds().has(userId);
}

export function getPublicCollaboratorUserIds(): Set<string> {
  return parseUserIds(process.env.NEXT_PUBLIC_PETDEX_COLLABORATOR_USER_IDS);
}

export function getPublishedPetModeratorUserIds(): Set<string> {
  return parseUserIds(process.env.PETDEX_MODERATOR_USER_IDS);
}

export function getPublicPublishedPetModeratorUserIds(): Set<string> {
  return parseUserIds(process.env.NEXT_PUBLIC_PETDEX_MODERATOR_USER_IDS);
}

export function isHenry(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return Boolean(HENRY_USER_ID && userId === HENRY_USER_ID);
}

export function isHenryClientSafe(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return Boolean(PUBLIC_HENRY_USER_ID && userId === PUBLIC_HENRY_USER_ID);
}

export function canAccessCollaboratorArea(
  userId: string | null | undefined,
): boolean {
  return (
    isCollaborator(userId) ||
    isHenry(userId) ||
    canModeratePublishedPets(userId)
  );
}

export function canAccessCollaboratorAreaClientSafe(
  userId: string | null | undefined,
): boolean {
  return (
    isCollaboratorClientSafe(userId) ||
    isHenryClientSafe(userId) ||
    canModeratePublishedPetsClientSafe(userId)
  );
}

export function isCollaboratorClientSafe(
  userId: string | null | undefined,
): boolean {
  if (!userId) return false;
  if (isAdminClientSafe(userId)) return true;
  return getPublicCollaboratorUserIds().has(userId);
}

export function canEditWeChatQr(userId: string | null | undefined): boolean {
  return isCollaborator(userId) || isHenry(userId);
}

export function canEditWeChatQrClientSafe(
  userId: string | null | undefined,
): boolean {
  return isCollaboratorClientSafe(userId) || isHenryClientSafe(userId);
}

export function canReviewPetSubmissions(
  userId: string | null | undefined,
): boolean {
  return isCollaborator(userId);
}

export function canReviewPetRequests(
  userId: string | null | undefined,
): boolean {
  return isCollaborator(userId);
}

export function canReviewCollectionRequests(
  userId: string | null | undefined,
): boolean {
  return isCollaborator(userId);
}

export function canReviewMetadataEdits(
  userId: string | null | undefined,
): boolean {
  return isCollaborator(userId);
}

export function canModeratePublishedPets(
  userId: string | null | undefined,
): boolean {
  if (!userId) return false;
  if (isAdmin(userId)) return true;
  return getPublishedPetModeratorUserIds().has(userId);
}

export function canModeratePublishedPetsClientSafe(
  userId: string | null | undefined,
): boolean {
  if (!userId) return false;
  if (isAdminClientSafe(userId)) return true;
  return getPublicPublishedPetModeratorUserIds().has(userId);
}
