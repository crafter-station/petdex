import { findBlockedKeyword } from "@/lib/keyword-blocklist";
import { containsUrl, type UrlHit } from "@/lib/url-blocklist";

// The submission path runs every pet through the keyword and URL
// blocklists. The admin-import script used to skip both, so one command
// could publish pre-approved content the normal flow rejects. The check is
// not an approval step — --approve still skips human review — but the
// blocklists are the security baseline the keyword-sweep script re-runs
// later, so bypassing them needs an explicit --skip-blocklist. Extracted
// here so tests can pin the gate without spawning the script.
export type ImportGateFields = {
  displayName: string;
  description: string;
  creditName?: string | null;
  creditUrl?: string | null;
};

export type ImportGateRejection =
  | { kind: "keyword"; keyword: string }
  | { kind: "url"; field: string; reason: string };

export function gateImportText(
  fields: ImportGateFields,
): ImportGateRejection | null {
  const keywordHit = findBlockedKeyword(
    fields.displayName,
    fields.description,
    fields.creditName ?? undefined,
  );
  if (keywordHit) {
    return { kind: "keyword", keyword: keywordHit.keyword };
  }
  const hit: UrlHit | null = containsUrl(
    ["description", fields.description],
    ["creditUrl", fields.creditUrl ?? undefined],
    ["creditName", fields.creditName ?? undefined],
  );
  if (hit) {
    return { kind: "url", field: hit.field, reason: "url_in_field" };
  }
  return null;
}
