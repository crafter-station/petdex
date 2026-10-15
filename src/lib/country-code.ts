// Two-letter ISO 3166-1 alpha-2 country code normalization. The
// telemetry endpoint and any other public endpoint that stores a
// country header MUST go through this — otherwise the admin geo
// dashboard fills up with junk strings ("ZZ", "<script>", SQL
// injection attempts). We accept the value only if it's exactly 2
// ASCII uppercase letters; anything else returns null so the
// dashboard treats it as "unknown" rather than rendering the
// attacker payload as a country name.

const COUNTRY_CODE_RE = /^[A-Z]{2}$/;

export function normalizeCountry(
  raw: string | null | undefined,
): string | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  return COUNTRY_CODE_RE.test(upper) ? upper : null;
}

// Vercel's `x-vercel-ip-country-region` is a subdivision code — a short run of
// letters and digits ("CA", "ENG", "13"), occasionally with a dash. There is no
// ISO list bundled here to validate against, so bound the shape rather than the
// value: reject anything over 8 chars or outside [A-Z0-9-] so a proxied
// deployment cannot land a long or hostile string in the unbounded `region`
// column. Same "unknown, not the raw payload" contract as normalizeCountry.
const REGION_CODE_RE = /^[A-Z0-9-]{1,8}$/;

export function normalizeRegion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  return REGION_CODE_RE.test(upper) ? upper : null;
}
