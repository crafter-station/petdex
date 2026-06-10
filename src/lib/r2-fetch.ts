import { toCurrentR2PublicUrl } from "@/lib/r2-public-url";

export const PETDEX_ASSET_REFERER = "https://petdex.dev/";

export function fetchR2Asset(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Referer")) headers.set("Referer", PETDEX_ASSET_REFERER);
  const target =
    typeof input === "string"
      ? toCurrentR2PublicUrl(input)
      : input instanceof URL
        ? new URL(toCurrentR2PublicUrl(input.toString()))
        : input;
  return fetch(target, { ...init, headers });
}
