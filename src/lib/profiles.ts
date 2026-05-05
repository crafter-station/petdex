// Shared constants + helpers for user profiles. Centralized so the
// API, the inline editor, and the per-card pin button all agree on
// limits and types.

export const MAX_PINNED_PETS = 6;
export const MAX_PROFILE_DISPLAY_NAME = 48;
export const MIN_PROFILE_HANDLE_LENGTH = 3;
export const MAX_PROFILE_HANDLE_LENGTH = 30;

const PROFILE_HANDLE_RE = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/;

const RESERVED_HANDLES = new Set([
  "_next",
  "about",
  "admin",
  "api",
  "collections",
  "create",
  "docs",
  "en",
  "es",
  "favicon.ico",
  "install",
  "kind",
  "leaderboard",
  "legal",
  "manifest",
  "my-feedback",
  "my-pets",
  "pets",
  "requests",
  "robots.txt",
  "sitemap.xml",
  "submit",
  "u",
  "vibe",
  "zh",
]);

export function dedupePins(slugs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const slug of slugs) {
    if (typeof slug !== "string") continue;
    const v = slug.trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_PINNED_PETS) break;
  }
  return out;
}

export function isPinOnlyProfilePatch(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const patch = body as Record<string, unknown>;
  const hasPinMutation =
    "featuredPetSlugs" in patch || "pin" in patch || "unpin" in patch;
  const hasIdentityMutation =
    "displayName" in patch ||
    "handle" in patch ||
    "bio" in patch ||
    "preferredLocale" in patch;
  return hasPinMutation && !hasIdentityMutation;
}

export function normalizeProfileDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, MAX_PROFILE_DISPLAY_NAME) : null;
}

export function normalizeProfileHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

export function validateProfileHandle(
  handle: string | null,
): "ok" | "too_short" | "too_long" | "invalid_format" | "reserved" {
  if (handle === null) return "ok";
  if (handle.length < MIN_PROFILE_HANDLE_LENGTH) return "too_short";
  if (handle.length > MAX_PROFILE_HANDLE_LENGTH) return "too_long";
  if (!PROFILE_HANDLE_RE.test(handle)) return "invalid_format";
  if (RESERVED_HANDLES.has(handle)) return "reserved";
  return "ok";
}
