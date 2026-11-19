import {
  DEFAULT_R2_PUBLIC_BASE,
  R2_PUBLIC_BASE,
  R2_TRUSTED_HOSTS,
} from "@/lib/r2-public-url";

export type PendingAssetRole = "sprite" | "petjson" | "zip";

const UPLOAD_ID_RE = /^[0-9a-f]{12}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function roleExtensionPattern(role: PendingAssetRole): string {
  switch (role) {
    case "sprite":
      return "(?:webp|png)";
    case "petjson":
      return "json";
    case "zip":
      return "zip";
  }
}

function roleExtensionAllowed(
  role: PendingAssetRole,
  extension: string,
): boolean {
  if (role === "sprite") return extension === "webp" || extension === "png";
  return role === "petjson" ? extension === "json" : extension === "zip";
}

export function buildPendingAssetKey(
  slug: string,
  uploadId: string,
  role: PendingAssetRole,
  extension: string,
): string | null {
  if (!SLUG_RE.test(slug) || !UPLOAD_ID_RE.test(uploadId)) return null;
  if (!roleExtensionAllowed(role, extension)) return null;
  return `pets/${slug}-pending-${uploadId}/${role}.${extension}`;
}

export function isPendingAssetKey(
  key: string | null | undefined,
  slug?: string,
  role?: PendingAssetRole,
): boolean {
  if (!key) return false;
  const slugPattern = slug ? escapeRegExp(slug) : "[a-z0-9]+(?:-[a-z0-9]+)*";
  if (slug && !SLUG_RE.test(slug)) return false;
  const rolePattern = role
    ? `${role}\\.${roleExtensionPattern(role)}`
    : `(?:sprite\\.${roleExtensionPattern("sprite")}|petjson\\.json|zip\\.zip)`;
  return new RegExp(
    `^pets/${slugPattern}-pending-[0-9a-f]{12}/${rolePattern}$`,
  ).test(key);
}

function basePathsForHost(host: string): string[] {
  const paths = [DEFAULT_R2_PUBLIC_BASE, R2_PUBLIC_BASE]
    .map((base) => new URL(base))
    .filter((base) => base.host === host)
    .map((base) => base.pathname.replace(/\/+$/, ""));
  return Array.from(new Set(paths));
}

export function isPendingAssetUrl(
  raw: string | null | undefined,
  slug: string,
  role: PendingAssetRole,
): boolean {
  if (!raw || !SLUG_RE.test(slug)) return false;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (
    url.protocol !== "https:" ||
    !R2_TRUSTED_HOSTS.has(url.host) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return false;
  }

  return basePathsForHost(url.host).some((basePath) => {
    const prefix = `${basePath}/`;
    if (!url.pathname.startsWith(prefix)) return false;
    return isPendingAssetKey(url.pathname.slice(prefix.length), slug, role);
  });
}

// Submission uploads (`/api/cli/submit`, `/api/r2/presign`) write
// `pets/<slugHint>-<uploadId>/<role>.<ext>` — same bucket, same shape as a
// pending-edit key but WITHOUT the `-pending-` marker, so `isPendingAssetKey`
// never matched them and the GC never considered them. A caller that presigns
// and then never registers the submission (or withdraws it) leaves objects no
// sweep would ever collect.
//
// Note this also matches pending keys (`pets/<slug>-pending-<id>/…`, where the
// slug part absorbs the `-pending` segment); that is harmless because both
// shapes are GC candidates. The dangerous half is the reference side: any
// sweep that treats these as candidates MUST also count them as referenced
// when a live row points at them, or it deletes live pets' assets.
export function isSubmissionAssetKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return /^pets\/[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{12}\/(?:sprite\.(?:webp|png)|petjson\.json|zip\.zip)$/.test(
    key,
  );
}

/** Either GC-eligible key shape (pending-edit or submission upload). */
export function isGcCandidateAssetKey(key: string | null | undefined): boolean {
  return isPendingAssetKey(key) || isSubmissionAssetKey(key);
}
