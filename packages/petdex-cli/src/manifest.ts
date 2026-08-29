import { isTrustedAssetUrl } from "./asset-hosts.js";

const MANIFEST_TIMEOUT_MS = 15_000;
const COMPACT_FIELDS = [
  "slug",
  "displayName",
  "kind",
  "submittedBy",
  "spritesheet",
  "petJson",
  "zip",
  "spriteVersionNumber",
] as const;

export type ManifestPet = {
  slug: string;
  displayName: string;
  kind: string;
  submittedBy: string | null;
  spritesheetUrl: string;
  petJsonUrl: string;
  zipUrl: string | null;
  spriteVersionNumber: 1 | 2;
};

type FetchJson = (input: string | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSpriteVersion(value: unknown): value is 1 | 2 {
  return value === 1 || value === 2;
}

function requireTrustedAssetUrl(raw: string, assetBase?: string): string {
  let url: URL;
  try {
    url = assetBase
      ? new URL(raw, `${assetBase.replace(/\/+$/, "")}/`)
      : new URL(raw);
  } catch {
    throw new Error("manifest contains an invalid asset URL");
  }
  const resolved = url.toString();
  if (!isTrustedAssetUrl(resolved)) {
    throw new Error("manifest contains an untrusted asset host");
  }
  return resolved;
}

function requireAssetBase(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new Error("compact manifest is missing assetBase");
  }
  return requireTrustedAssetUrl(raw);
}

function validateManifestTotal(
  input: Record<string, unknown>,
  count: number,
): void {
  if (input.total !== undefined && input.total !== count) {
    throw new Error("manifest total does not match its entries");
  }
}

export function parseCompactManifest(input: unknown): ManifestPet[] {
  if (!isRecord(input) || input.v !== 2 || !Array.isArray(input.pets)) {
    throw new Error("invalid compact manifest");
  }
  const assetBase = requireAssetBase(input.assetBase);
  if (
    !Array.isArray(input.fields) ||
    input.fields.length !== COMPACT_FIELDS.length ||
    input.fields.some((field, index) => field !== COMPACT_FIELDS[index])
  ) {
    throw new Error("invalid compact manifest fields");
  }
  validateManifestTotal(input, input.pets.length);

  return input.pets.map((rawPet, index) => {
    if (
      !Array.isArray(rawPet) ||
      rawPet.length !== COMPACT_FIELDS.length ||
      typeof rawPet[0] !== "string" ||
      typeof rawPet[1] !== "string" ||
      typeof rawPet[2] !== "string" ||
      !isNullableString(rawPet[3]) ||
      typeof rawPet[4] !== "string" ||
      typeof rawPet[5] !== "string" ||
      !isNullableString(rawPet[6]) ||
      !isSpriteVersion(rawPet[7])
    ) {
      throw new Error(`invalid compact manifest pet at index ${index}`);
    }
    return {
      slug: rawPet[0],
      displayName: rawPet[1],
      kind: rawPet[2],
      submittedBy: rawPet[3],
      spritesheetUrl: requireTrustedAssetUrl(rawPet[4], assetBase),
      petJsonUrl: requireTrustedAssetUrl(rawPet[5], assetBase),
      zipUrl: rawPet[6] ? requireTrustedAssetUrl(rawPet[6], assetBase) : null,
      spriteVersionNumber: rawPet[7],
    };
  });
}

export function parseLegacyManifest(input: unknown): ManifestPet[] {
  if (!isRecord(input) || !Array.isArray(input.pets)) {
    throw new Error("invalid legacy manifest");
  }
  validateManifestTotal(input, input.pets.length);

  return input.pets.map((rawPet, index) => {
    if (
      !isRecord(rawPet) ||
      typeof rawPet.slug !== "string" ||
      typeof rawPet.displayName !== "string" ||
      typeof rawPet.kind !== "string" ||
      !isNullableString(rawPet.submittedBy) ||
      typeof rawPet.spritesheetUrl !== "string" ||
      typeof rawPet.petJsonUrl !== "string" ||
      !isNullableString(rawPet.zipUrl) ||
      (rawPet.spriteVersionNumber !== undefined &&
        !isSpriteVersion(rawPet.spriteVersionNumber))
    ) {
      throw new Error(`invalid legacy manifest pet at index ${index}`);
    }
    return {
      slug: rawPet.slug,
      displayName: rawPet.displayName,
      kind: rawPet.kind,
      submittedBy: rawPet.submittedBy,
      spritesheetUrl: requireTrustedAssetUrl(rawPet.spritesheetUrl),
      petJsonUrl: requireTrustedAssetUrl(rawPet.petJsonUrl),
      zipUrl: rawPet.zipUrl ? requireTrustedAssetUrl(rawPet.zipUrl) : null,
      spriteVersionNumber: rawPet.spriteVersionNumber ?? 1,
    };
  });
}

export function parseManifestPayload(input: unknown): ManifestPet[] {
  if (isRecord(input) && input.v === 2) return parseCompactManifest(input);
  return parseLegacyManifest(input);
}

async function requestJson(
  fetchImpl: FetchJson,
  url: string,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`manifest fetch ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error("manifest response was not valid JSON");
  }
}

export async function fetchManifest(
  petdexUrl: string,
  fetchImpl: FetchJson = fetch,
): Promise<ManifestPet[]> {
  const base = petdexUrl.replace(/\/+$/, "");
  let compactError: unknown;
  try {
    return parseCompactManifest(
      await requestJson(fetchImpl, `${base}/api/manifest/v2`),
    );
  } catch (error) {
    compactError = error;
  }

  try {
    return parseLegacyManifest(
      await requestJson(fetchImpl, `${base}/api/manifest`),
    );
  } catch (legacyError) {
    const compactMessage =
      compactError instanceof Error ? compactError.message : "unknown error";
    const legacyMessage =
      legacyError instanceof Error ? legacyError.message : "unknown error";
    throw new Error(
      `manifest unavailable (v2: ${compactMessage}; legacy: ${legacyMessage})`,
    );
  }
}
