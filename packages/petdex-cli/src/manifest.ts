import { isTrustedAssetUrl } from "./asset-hosts.js";
import { fetchCapped } from "./fetch-capped.js";

const MANIFEST_TIMEOUT_MS = 15_000;
// Every other network read in this package goes through fetchCapped's
// byte ceiling; the manifest is the largest of them, so give it its own
// (still generous) limit rather than an unbounded response.json().
const MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
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

/**
 * The slug shape the install paths are built from.
 *
 * `petdex install` joins the slug into `~/.petdex/pets/<slug>` and
 * `~/.codex/pets/<slug>`, so a slug like `../../../../tmp/pwned` escapes the
 * pets directory — `path.join` resolves it to `/tmp/pwned`. The server
 * enforces this shape on `/install/<slug>`; the CLI did not, so a manifest
 * carrying such a slug (a tampered snapshot, or a row that slipped past
 * `deriveSlug`) wrote outside the pets directory. Mirrors
 * `INSTALL_SLUG_RE` in the install routes.
 *
 * Exported for the install path to check, rather than thrown from the
 * manifest parse: a single bad slug would otherwise fail the whole manifest
 * and take every pet down with it, when only that one pet is unusable.
 */
export function isInstallSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(value);
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
      displayName: stripControlChars(rawPet[1]),
      kind: rawPet[2],
      submittedBy: rawPet[3] === null ? null : stripControlChars(rawPet[3]),
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
      displayName: stripControlChars(rawPet.displayName),
      kind: rawPet.kind,
      submittedBy:
        rawPet.submittedBy === null
          ? null
          : stripControlChars(rawPet.submittedBy),
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

// displayName and submittedBy come from submitter profiles and are echoed
// straight back to the terminal (`petdex list`, install notes). A field
// holding `\x1b]0;pwned\x07` (title rewrite) or cursor-mode escapes would
// execute against whichever display width the terminal applies — strip every
// C0/C1 control character and the DEL before the text can reach a console.
// Printable Unicode survives; only controls are dropped.
const CONTROL_CHARS = /[\p{Cc}]/gu;

export function stripControlChars(raw: string): string {
  return raw.replace(CONTROL_CHARS, "");
}

async function requestJson(
  fetchImpl: FetchJson,
  url: string,
): Promise<unknown> {
  const result = await fetchCapped(url, {
    init: {
      headers: { Accept: "application/json" },
    },
    maxBytes: MANIFEST_MAX_BYTES,
    timeoutMs: MANIFEST_TIMEOUT_MS,
    // FetchJson is the narrow seam tests stub; fetchCapped accepts the
    // full `typeof fetch`, which the real fetch satisfies.
    fetchImpl: fetchImpl as typeof fetch,
  });
  if (!result.ok) throw new Error(`manifest fetch ${result.status}`);
  try {
    return JSON.parse(result.body.toString("utf8"));
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
