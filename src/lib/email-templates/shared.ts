import { defaultLocale, localizePath, type Locale } from "@/i18n/config";

const SITE_URL = "https://petdex.crafter.run";

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

export function p(text: string): string {
  return `<p style="margin:0 0 16px;line-height:1.6;">${textToHtml(text)}</p>`;
}

export function codeBlock(text: string): string {
  return `<pre style="margin:0 0 16px;padding:14px;border-radius:12px;background:#111827;color:#f9fafb;overflow:auto;font-size:13px;line-height:1.5;">${escapeHtml(text)}</pre>`;
}

export function quoteBlock(text: string): string {
  return `<blockquote style="margin:0 0 16px;padding:0 0 0 12px;border-left:3px solid #d6d3d1;color:#44403c;">${textToHtml(text)}</blockquote>`;
}
