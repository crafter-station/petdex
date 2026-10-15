import { locales } from "@/i18n/config";

/**
 * Next replaces the sub-request's headers with the set of names listed in this
 * header, taking each value from the matching `x-middleware-request-<name>`.
 * `next-intl` uses it to carry `x-next-intl-locale` across its own rewrite.
 */
const OVERRIDE_HEADERS = "x-middleware-override-headers";

/** The marker `markLocaleRewrite` leaves on the rewrite it marks. */
export const LOCALE_REWRITE_MARKER = "x-petdex-locale-rewrite";

/**
 * A value no caller can produce, so the marker cannot be forged.
 *
 * `x-middleware-override-headers` is one of Next's `INTERNAL_HEADERS`
 * (`next/dist/server/lib/server-ipc/utils.js`), so Next deletes it from every
 * request that arrives from outside before the proxy runs; the only way it
 * reaches the proxy is on a re-run of Next's own making. That would already
 * rule out a plain header check, but the marker is also compared against a
 * value generated in this process and never written anywhere a client can
 * read, which closes the gap for any Next version that stops filtering it.
 *
 * The cost is that the marker is per process: if a deployment answers the
 * re-run from a different instance, the comparison fails and the request takes
 * the unmarked path — the redirect loop this module exists to break — rather
 * than misrouting anything. That is the same behaviour as not shipping the
 * guard, so the failure mode is safe.
 */
const REWRITE_TOKEN = createToken();

function createToken(): string {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === "function") {
    return webCrypto.randomUUID();
  }
  // Only reached on a runtime without Web Crypto, where the marker still has
  // to differ between processes rather than be unguessable.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Marks a rewrite so the proxy can recognise its own re-entry.
 *
 * Only a response that already carries request-header overrides is marked:
 * that is what tells `next-intl`'s rewrite apart from a redirect, and a
 * redirect never comes back through the proxy, so there is nothing to mark.
 * The header list is extended rather than replaced because Next reads it as
 * the complete set of request headers to keep — shrinking it to the marker
 * alone would drop every cookie and auth header the rewrite carried.
 */
export function markLocaleRewrite<T extends { headers: Headers }>(
  response: T,
): T {
  const overrides = response.headers.get(OVERRIDE_HEADERS);
  if (!overrides) return response;

  response.headers.set(
    OVERRIDE_HEADERS,
    `${overrides},${LOCALE_REWRITE_MARKER}`,
  );
  response.headers.set(
    `x-middleware-request-${LOCALE_REWRITE_MARKER}`,
    REWRITE_TOKEN,
  );
  return response;
}

/**
 * True when this request is the proxy re-running on its own rewrite target.
 *
 * With `localePrefix: "as-needed"`, next-intl answers an unprefixed
 * default-locale path by rewriting it to the prefixed one — `/download` to
 * `/en/download` — and Next then re-runs the proxy on that target. next-intl
 * sees the very prefix it just added and strips it back off, so `/download`
 * answers `307` to `/download` forever. Locale-prefixed paths and `/api`
 * never rewrite, which is why they were the only routes that worked locally.
 *
 * Production resolves this before the proxy sees it (Vercel's build output
 * and the Cloudflare cache both serve the unprefixed path directly), so the
 * loop only appears when the app is served locally.
 *
 * Both conditions matter. The marker proves the prefix came from our own
 * rewrite rather than from the caller; the pathname check proves we stand down
 * only on a path that already carries a locale, since skipping routing on an
 * unprefixed one would hand a locale-less path to a page that needs it. The
 * comparison is case-sensitive: next-intl matches a prefix case-insensitively
 * but records it as inexact and redirects, so only the exact spelling is a
 * path it would have refused to route.
 *
 * Lives outside `proxy.ts` so it can be exercised directly: that module pulls
 * in Clerk and next-intl, which a unit test cannot import.
 */
export function isResolvedLocaleRewrite(input: {
  marker: string | null;
  pathname: string;
}): boolean {
  const { marker, pathname } = input;
  if (marker !== REWRITE_TOKEN) return false;
  return locales.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`),
  );
}
