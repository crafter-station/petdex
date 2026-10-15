import { defaultLocale, type Locale, localizePath } from "@/i18n/config";

const SITE_URL = "https://petdex.dev";

export function normalizeLocale(locale: Locale | null | undefined): Locale {
  return locale ?? defaultLocale;
}

export function petdexUrl(locale: Locale, pathname: string): string {
  return `${SITE_URL}${localizePath(locale, pathname)}`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Make a user-supplied value safe to interpolate into a subject line.
 *
 * Pet names, display names and request queries reach the `subject` of the
 * transactional emails, and a CR/LF in a header value is the classic SMTP
 * header-injection vector. The Resend SDK sends JSON, so the final fold
 * happens server-side at Resend, but the value is still the app's to clean —
 * and a previous defense in `submissions.ts` was bypassable: it used
 * `subject.replace(displayName, safeName)`, whose replacement string
 * expands `$&`, so a name containing `$&` re-inserted the matched CRLF.
 *
 * Strips every C0 control character (CR, LF, TAB, NUL, …) and DEL, then
 * trims. Apply at the point of interpolation so every caller is covered.
 */
export function sanitizeSubject(value: string): string {
  // charCode loop rather than a control-character regex: Biome rejects
  // control chars in patterns, and consecutive ones must collapse to one
  // space so "A\r\nB" reads "A B", not "A  B".
  let out = "";
  let pendingSpace = false;
  for (const char of String(value)) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += char;
  }
  return out.trim();
}

export function textToHtml(value: string): string {
  return escapeHtml(value).replaceAll("\n", "<br />");
}

export function wrapEmail(title: string, blocks: string[]): string {
  return [
    "<!doctype html>",
    '<html><body style="margin:0;padding:24px;background:#f7f5f2;color:#171717;font-family:ui-sans-serif,system-ui,sans-serif;">',
    '<div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:24px;">',
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.2;">${escapeHtml(title)}</h1>`,
    ...blocks,
    '<p style="margin:24px 0 0;color:#57534e;font-size:13px;">Petdex</p>',
    "</div></body></html>",
  ].join("");
}

export function buildUnsubscribeFooter(
  locale: Locale,
  unsubscribeToken: string,
): { html: string; text: string } {
  const url = `${SITE_URL}${localizePath(locale, "/unsubscribe")}?token=${encodeURIComponent(unsubscribeToken)}`;
  const html = `<p style="margin:32px 0 0;padding-top:16px;border-top:1px solid #e7e5e4;color:#a8a29e;font-size:11px;line-height:1.5;">You are receiving this because you signed up for Petdex. <a href="${url}" style="color:#a8a29e;text-decoration:underline;">Unsubscribe</a></p>`;
  const text = `\n\n---\nYou are receiving this because you signed up for Petdex.\nUnsubscribe: ${url}`;
  return { html, text };
}

export function wrapBroadcastEmail(
  title: string,
  blocks: string[],
  locale: Locale,
  unsubscribeToken: string,
): string {
  const footer = buildUnsubscribeFooter(locale, unsubscribeToken);
  return [
    "<!doctype html>",
    '<html><body style="margin:0;padding:24px;background:#f7f5f2;color:#171717;font-family:ui-sans-serif,system-ui,sans-serif;">',
    '<div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:24px;">',
    `<h1 style="margin:0 0 16px;font-size:22px;line-height:1.2;">${escapeHtml(title)}</h1>`,
    ...blocks,
    footer.html,
    "</div></body></html>",
  ].join("");
}

export function p(text: string): string {
  return `<p style="margin:0 0 16px;line-height:1.6;">${textToHtml(text)}</p>`;
}

export function codeBlock(text: string): string {
  return `<pre style="margin:0 0 16px;padding:14px;border-radius:12px;background:#111827;color:#f9fafb;overflow:auto;font-size:13px;line-height:1.5;">${escapeHtml(text)}</pre>`;
}

export function quoteBlock(text: string): string {
  return `<blockquote style="margin:0 0 16px;padding:0 0 0 12px;border-left:3px solid #d6d3d1;color:#44403c;">${textToHtml(text)}</blockquote>`;
}
