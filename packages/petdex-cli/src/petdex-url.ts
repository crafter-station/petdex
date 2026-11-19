export type ResolvedPetdexUrl =
  | { ok: true; url: string }
  | { ok: false; reason: string };

// Bearer tokens ride every request the base URL produces, so the override
// follows the issuer rule: https only, http allowed for loopback where a dev
// stack runs. Returned as a result (not thrown) because the CLI calls this
// at module scope, before main().catch exists to catch anything.
export function checkPetdexUrl(raw: string): ResolvedPetdexUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `PETDEX_URL is not a valid URL: ${raw}` };
  }
  if (url.protocol !== "https:") {
    const isLoopback =
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!isLoopback) {
      return {
        ok: false,
        reason:
          "PETDEX_URL must use https (http is allowed only for localhost)",
      };
    }
  }
  return { ok: true, url: raw.replace(/\/+$/, "") };
}
