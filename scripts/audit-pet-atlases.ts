import { writeFile } from "node:fs/promises";

import sharp from "sharp";

import { petStates } from "../src/lib/pet-states";
import { readResponseBodyBounded as readSharedResponseBodyBounded } from "../src/lib/response-body";
import {
  canonicalSpriteDimensions,
  detectSpriteAtlas,
  SPRITE_COLUMNS,
  SPRITE_FRAME_HEIGHT,
  SPRITE_FRAME_WIDTH,
  type SpriteAtlasVersion,
} from "../src/lib/sprite-atlas";

const SEARCH_URL = "https://petdex.dev/api/pets/search";
const MANIFEST_V2_URL = "https://petdex.dev/api/manifest/v2";
const LEGACY_MANIFEST_URL = "https://petdex.dev/api/manifest";
const TRUSTED_ASSET_HOST = "assets.petdex.dev";
const MAX_FETCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_WINDOW = 64;
const MAX_WINDOW = 500;
const MAX_NETWORK_ATTEMPTS = 3;
const RETRY_DELAY_MS = 250;
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

/**
 * Checks that still require a human or Petdex edit/review workflow. Keep
 * these explicit so every manifest entry carries the same review contract.
 */
export const MANUAL_REVIEW_CHECKS = [
  "idle eye-open default state",
  "action continuity and direction consistency",
  "transparent edge bounds and left/right clipping",
  "sprite scale consistency and flattened proportions",
  "state-row proportion and frame-to-frame continuity",
  "compression artifacts and visual integrity",
] as const;

type AuditPet = {
  slug: string;
  approvedAt: string | null;
  spritesheetUrl: string;
  spriteVersionNumber: 1 | 2;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

type FrameBounds = {
  row: number;
  column: number;
  width: number;
  height: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  centerX: number;
  centerY: number;
  aspectRatio: number;
  touchesEdge: boolean;
};

export type AtlasPixelSummary = {
  expectedFrames: number;
  emptyFrames: number;
  touchingFrames: number;
  geometryOutliers: number;
  proportionOutliers: number;
  continuityOutliers: number;
  rowProportionOutliers: number;
  edgeTouches: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
  rowMedians: Array<{
    row: number;
    width: number;
    height: number;
    aspectRatio: number;
  }>;
};

export type AtlasAuditEntry = {
  slug: string;
  approvedAt: string | null;
  spritesheetUrl: string;
  declaredVersion: 1 | 2;
  detectedVersion: 1 | 2 | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  summary: AtlasPixelSummary | null;
  error: string | null;
  errorKind: "network" | "asset" | null;
};

type AuditEntryDetails = Omit<
  AtlasAuditEntry,
  "slug" | "approvedAt" | "spritesheetUrl"
>;

export function createAuditEntry(
  pet: Pick<AuditPet, "slug" | "approvedAt" | "spritesheetUrl">,
  details: AuditEntryDetails,
): AtlasAuditEntry {
  return { ...pet, ...details };
}

export type MachineAuditFlag =
  | "network-error"
  | "asset-error"
  | "unsupported-dimensions"
  | "version-mismatch"
  | "empty-frame"
  | "edge-touch"
  | "left-edge-touch"
  | "right-edge-touch"
  | "top-edge-touch"
  | "bottom-edge-touch"
  | "geometry-outlier"
  | "flattened-proportion"
  | "frame-continuity"
  | "row-proportion";

/**
 * Turn numeric audit findings into stable review queue labels. These labels
 * describe machine-detected risk only; visual approval still requires the
 * separate manualReview record.
 */
export function classifyAuditEntry(
  entry: Pick<AtlasAuditEntry, "error" | "errorKind" | "summary">,
): MachineAuditFlag[] {
  const flags: MachineAuditFlag[] = [];
  if (entry.errorKind === "network") flags.push("network-error");
  if (entry.errorKind === "asset") flags.push("asset-error");
  if (entry.error === "unsupported atlas dimensions") {
    flags.push("unsupported-dimensions");
  }
  if (entry.error?.includes("declared sprite version")) {
    flags.push("version-mismatch");
  }

  const summary = entry.summary;
  if (!summary) return flags;
  if (summary.emptyFrames > 0) flags.push("empty-frame");
  if (summary.touchingFrames > 0) flags.push("edge-touch");
  if (summary.edgeTouches.left > 0) flags.push("left-edge-touch");
  if (summary.edgeTouches.right > 0) flags.push("right-edge-touch");
  if (summary.edgeTouches.top > 0) flags.push("top-edge-touch");
  if (summary.edgeTouches.bottom > 0) flags.push("bottom-edge-touch");
  if (summary.geometryOutliers > 0) flags.push("geometry-outlier");
  if (summary.proportionOutliers > 0) flags.push("flattened-proportion");
  if (summary.continuityOutliers > 0) flags.push("frame-continuity");
  if (summary.rowProportionOutliers > 0) flags.push("row-proportion");
  return flags;
}

export type ManualReviewRecord = {
  status: "pending";
  checks: readonly string[];
};

export type PublicAuditErrorCode =
  | "network-error"
  | "asset-error"
  | "asset-size-limit"
  | "asset-read-timeout"
  | "unsupported-atlas-dimensions"
  | "version-mismatch";

/**
 * The committed review queue is public repository data. Keep this type
 * deliberately smaller than AtlasAuditEntry so raw fetch/decode errors and
 * implementation details never leave the audit process.
 */
export type PublicAuditReviewEntry = {
  slug: string;
  spritesheetUrl: string;
  declaredVersion: 1 | 2;
  detectedVersion: 1 | 2 | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  summary: PublicAtlasPixelSummary | null;
  machineFlags: MachineAuditFlag[];
  errorCode: PublicAuditErrorCode | null;
  manualReview: ManualReviewRecord;
};

export type PublicAtlasPixelSummary = Omit<AtlasPixelSummary, "rowMedians">;

function toPublicAtlasPixelSummary(
  summary: AtlasPixelSummary | null,
): PublicAtlasPixelSummary | null {
  if (!summary) return null;
  return {
    expectedFrames: summary.expectedFrames,
    emptyFrames: summary.emptyFrames,
    touchingFrames: summary.touchingFrames,
    geometryOutliers: summary.geometryOutliers,
    proportionOutliers: summary.proportionOutliers,
    continuityOutliers: summary.continuityOutliers,
    rowProportionOutliers: summary.rowProportionOutliers,
    edgeTouches: summary.edgeTouches,
  };
}

function publicAuditErrorCode(
  entry: Pick<AtlasAuditEntry, "error" | "errorKind">,
): PublicAuditErrorCode | null {
  if (!entry.error) return null;
  if (entry.errorKind === "network") return "network-error";
  if (entry.error === "asset exceeds audit limit") return "asset-size-limit";
  if (entry.error === "asset read timed out") return "asset-read-timeout";
  if (entry.error === "unsupported atlas dimensions") {
    return "unsupported-atlas-dimensions";
  }
  if (entry.error.includes("declared sprite version")) {
    return "version-mismatch";
  }
  return "asset-error";
}

/** Project an internal audit result into the stable, public review contract. */
export function toPublicAuditReviewEntry(
  entry: AtlasAuditEntry,
): PublicAuditReviewEntry {
  const spritesheetUrl = resolveManifestAsset(undefined, entry.spritesheetUrl);
  return {
    slug: entry.slug,
    spritesheetUrl,
    declaredVersion: entry.declaredVersion,
    detectedVersion: entry.detectedVersion,
    width: entry.width,
    height: entry.height,
    bytes: entry.bytes,
    summary: toPublicAtlasPixelSummary(entry.summary),
    machineFlags: classifyAuditEntry(entry),
    errorCode: publicAuditErrorCode(entry),
    manualReview: {
      status: "pending",
      checks: MANUAL_REVIEW_CHECKS,
    },
  };
}

export type PublicAuditReviewReport = {
  generatedAt: string;
  scope: "oldest-approved-window" | "manifest";
  source: string;
  assetHost: typeof TRUSTED_ASSET_HOST;
  requested: number;
  manualReviewRequired: readonly string[];
  entries: PublicAuditReviewEntry[];
};

export function buildPublicAuditReviewReport(
  entries: AtlasAuditEntry[],
  scope: PublicAuditReviewReport["scope"],
  generatedAt: string,
  source: string,
): PublicAuditReviewReport {
  return {
    generatedAt,
    scope,
    source,
    assetHost: TRUSTED_ASSET_HOST,
    requested: entries.length,
    manualReviewRequired: MANUAL_REVIEW_CHECKS,
    entries: entries.map(toPublicAuditReviewEntry),
  };
}

function valueAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function numberArg(args: string[], flag: string, fallback: number): number {
  const value = Number(valueAfter(args, flag));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function expectedColumns(version: SpriteAtlasVersion, row: number): number {
  if (version === 2 && row >= 9) return SPRITE_COLUMNS;
  return petStates.find((state) => state.row === row)?.frames ?? 0;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Summarize cell geometry from a canonical RGBA atlas. */
export function summarizeAtlasPixels(
  data: Buffer,
  width: number,
  version: SpriteAtlasVersion,
): AtlasPixelSummary {
  const rows = version === 2 ? 11 : 9;
  const frames: FrameBounds[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < expectedColumns(version, row); column++) {
      let minX = SPRITE_FRAME_WIDTH;
      let minY = SPRITE_FRAME_HEIGHT;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < SPRITE_FRAME_HEIGHT; y++) {
        for (let x = 0; x < SPRITE_FRAME_WIDTH; x++) {
          const alpha =
            data[
              ((row * SPRITE_FRAME_HEIGHT + y) * width +
                column * SPRITE_FRAME_WIDTH +
                x) *
                4 +
                3
            ];
          if (alpha <= 8) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
      const visible = maxX >= 0;
      frames.push({
        row,
        column,
        width: visible ? maxX - minX + 1 : 0,
        height: visible ? maxY - minY + 1 : 0,
        minX: visible ? minX : 0,
        minY: visible ? minY : 0,
        maxX: visible ? maxX : 0,
        maxY: visible ? maxY : 0,
        centerX: visible ? (minX + maxX) / 2 : 0,
        centerY: visible ? (minY + maxY) / 2 : 0,
        aspectRatio: visible ? (maxX - minX + 1) / (maxY - minY + 1) : 0,
        touchesEdge:
          visible &&
          (minX === 0 ||
            minY === 0 ||
            maxX === SPRITE_FRAME_WIDTH - 1 ||
            maxY === SPRITE_FRAME_HEIGHT - 1),
      });
    }
  }

  const visible = frames.filter((frame) => frame.width > 0 && frame.height > 0);
  const medianWidth = median(visible.map((frame) => frame.width));
  const medianHeight = median(visible.map((frame) => frame.height));
  const medianAspectRatio = median(visible.map((frame) => frame.aspectRatio));
  const geometryOutliers = visible.filter(
    (frame) =>
      frame.width < Math.max(8, medianWidth * 0.45) ||
      frame.width > medianWidth * 1.8 ||
      frame.height < Math.max(8, medianHeight * 0.45) ||
      frame.height > medianHeight * 1.8,
  ).length;
  const proportionOutliers = visible.filter(
    (frame) =>
      frame.aspectRatio < Math.max(0.1, medianAspectRatio * 0.5) ||
      frame.aspectRatio > medianAspectRatio * 2,
  ).length;

  const rowMedians = Array.from({ length: rows }, (_, row) => {
    const rowFrames = visible.filter((frame) => frame.row === row);
    return {
      row,
      width: median(rowFrames.map((frame) => frame.width)),
      height: median(rowFrames.map((frame) => frame.height)),
      aspectRatio: median(rowFrames.map((frame) => frame.aspectRatio)),
    };
  });

  const rowProportionOutliers = rowMedians.filter(
    (row) =>
      row.aspectRatio > 0 &&
      (row.aspectRatio < Math.max(0.1, medianAspectRatio * 0.5) ||
        row.aspectRatio > medianAspectRatio * 2),
  ).length;

  let continuityOutliers = 0;
  for (let row = 0; row < rows; row++) {
    const rowFrames = visible
      .filter((frame) => frame.row === row)
      .sort((a, b) => a.column - b.column);
    const transitions = rowFrames.flatMap((frame, index) => {
      const previous = rowFrames[index - 1];
      if (!previous || frame.column !== previous.column + 1) return [];
      const travel = Math.hypot(
        frame.centerX - previous.centerX,
        frame.centerY - previous.centerY,
      );
      const scaleDelta = Math.max(
        Math.abs(frame.width / previous.width - 1),
        Math.abs(frame.height / previous.height - 1),
      );
      return [{ travel, scaleDelta }];
    });
    if (transitions.length === 0) continue;
    const medianTravel = median(
      transitions.map((transition) => transition.travel),
    );
    const medianScaleDelta = median(
      transitions.map((transition) => transition.scaleDelta),
    );
    continuityOutliers += transitions.filter(
      (transition) =>
        transition.travel > Math.max(24, medianTravel * 3) ||
        transition.scaleDelta > Math.max(0.35, medianScaleDelta * 3),
    ).length;
  }

  const edgeTouches = {
    left: visible.filter((frame) => frame.minX === 0).length,
    right: visible.filter((frame) => frame.maxX === SPRITE_FRAME_WIDTH - 1)
      .length,
    top: visible.filter((frame) => frame.minY === 0).length,
    bottom: visible.filter((frame) => frame.maxY === SPRITE_FRAME_HEIGHT - 1)
      .length,
  };

  return {
    expectedFrames: frames.length,
    emptyFrames: frames.filter((frame) => frame.width === 0).length,
    touchingFrames: visible.filter((frame) => frame.touchesEdge).length,
    geometryOutliers,
    proportionOutliers,
    continuityOutliers,
    rowProportionOutliers,
    edgeTouches,
    rowMedians,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableNetworkError(error: unknown): boolean {
  return /socket|timed out|timeout|fetch failed|network|connection|request failed \((408|429|5\d\d)\)/i.test(
    errorMessage(error),
  );
}

async function waitBeforeRetry(attempt: number): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, RETRY_DELAY_MS * 2 ** (attempt - 1)),
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`request failed (${response.status})`);
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (!isRetryableNetworkError(error) || attempt === MAX_NETWORK_ATTEMPTS)
        throw error;
      await waitBeforeRetry(attempt);
    }
  }
  throw lastError;
}

/** Read an asset without allowing a chunked response to exceed the audit cap. */
export async function readResponseBodyBounded(
  response: Response,
  maxBytes: number,
  timeoutMs = 15_000,
): Promise<Buffer> {
  try {
    return await readSharedResponseBodyBounded(response, maxBytes, timeoutMs);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error.message === "response body exceeds limit") {
      throw new Error("asset exceeds audit limit");
    }
    if (error.message === "response body read timed out") {
      throw new Error("asset read timed out");
    }
    if (error.message === "response body is empty") {
      throw new Error("asset response has no body");
    }
    throw error;
  }
}

async function fetchOldestWindow(limit: number): Promise<AuditPet[]> {
  const first = await fetchJson<{
    total?: number;
    pets: Array<Record<string, unknown>>;
  }>(`${SEARCH_URL}?sort=recent&limit=1&includeMeta=1`);
  const total = Number.isInteger(first.total) ? Number(first.total) : 0;
  const start = Math.max(0, total - limit);
  const pets: AuditPet[] = [];
  for (let cursor = start; cursor < total; cursor += 60) {
    const page = await fetchJson<{
      nextCursor: number | null;
      pets: Array<Record<string, unknown>>;
    }>(`${SEARCH_URL}?sort=recent&limit=60&cursor=${cursor}&includeMeta=0`);
    for (const pet of page.pets) {
      if (
        typeof pet.slug === "string" &&
        typeof pet.spritesheetPath === "string"
      ) {
        pets.push({
          slug: pet.slug,
          approvedAt:
            typeof pet.approvedAt === "string" ? pet.approvedAt : null,
          spritesheetUrl: pet.spritesheetPath,
          spriteVersionNumber: pet.spriteVersionNumber === 2 ? 2 : 1,
        });
      }
    }
    if (page.nextCursor === null) break;
  }
  return pets.slice(-limit).reverse();
}

type ManifestAuditInput = {
  pets: AuditPet[];
  source: string;
};

async function fetchManifest(): Promise<ManifestAuditInput> {
  let compactManifest: unknown;
  try {
    compactManifest = await fetchJson<unknown>(MANIFEST_V2_URL);
  } catch {
    const legacyManifest = await fetchJson<unknown>(LEGACY_MANIFEST_URL);
    return {
      pets: parseLegacyManifest(legacyManifest),
      source: LEGACY_MANIFEST_URL,
    };
  }
  return {
    pets: parseCompactManifest(compactManifest),
    source: MANIFEST_V2_URL,
  };
}

export function parseCompactManifest(input: unknown): AuditPet[] {
  if (!isRecord(input) || input.v !== 2 || !Array.isArray(input.pets)) {
    throw new Error("invalid compact manifest");
  }
  if (
    typeof input.assetBase !== "string" ||
    !isTrustedManifestBase(input.assetBase)
  ) {
    throw new Error("invalid compact manifest assetBase");
  }
  if (
    !Array.isArray(input.fields) ||
    input.fields.length !== COMPACT_FIELDS.length ||
    input.fields.some((field, index) => field !== COMPACT_FIELDS[index])
  ) {
    throw new Error("invalid compact manifest fields");
  }
  if (input.total !== undefined && input.total !== input.pets.length) {
    throw new Error("compact manifest total does not match its entries");
  }

  const assetBase = input.assetBase;
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
      (rawPet[7] !== 1 && rawPet[7] !== 2)
    ) {
      throw new Error(`invalid compact manifest pet at index ${index}`);
    }
    const slug = rawPet[0];
    const spritesheet = rawPet[4];
    const version = rawPet[7];
    return {
      slug,
      approvedAt: null,
      spritesheetUrl: resolveManifestAsset(assetBase, spritesheet),
      spriteVersionNumber: version,
    };
  });
}

function isTrustedManifestBase(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && parsed.host === TRUSTED_ASSET_HOST;
  } catch {
    return false;
  }
}

export function parseLegacyManifest(input: unknown): AuditPet[] {
  if (!isRecord(input) || !Array.isArray(input.pets)) {
    throw new Error("invalid legacy manifest");
  }
  return input.pets.map((rawPet, index) => {
    if (
      !isRecord(rawPet) ||
      typeof rawPet.slug !== "string" ||
      typeof rawPet.spritesheetUrl !== "string" ||
      (rawPet.spriteVersionNumber !== undefined &&
        rawPet.spriteVersionNumber !== 1 &&
        rawPet.spriteVersionNumber !== 2)
    ) {
      throw new Error(`invalid legacy manifest pet at index ${index}`);
    }
    return {
      slug: rawPet.slug,
      approvedAt: null,
      spritesheetUrl: resolveManifestAsset(undefined, rawPet.spritesheetUrl),
      spriteVersionNumber: rawPet.spriteVersionNumber === 2 ? 2 : 1,
    };
  });
}

export function resolveManifestAsset(
  assetBase: string | undefined,
  raw: string,
): string {
  let parsed: URL;
  try {
    parsed = new URL(
      raw,
      assetBase ? `${assetBase.replace(/\/$/, "")}/` : undefined,
    );
  } catch {
    throw new Error("manifest contains an invalid spritesheet URL");
  }
  if (parsed.protocol !== "https:" || parsed.host !== TRUSTED_ASSET_HOST) {
    throw new Error("manifest contains an untrusted spritesheet host");
  }
  return parsed.toString();
}

async function auditOne(pet: AuditPet): Promise<AtlasAuditEntry> {
  try {
    let buffer: Buffer | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(pet.spritesheetUrl, {
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok)
          throw new Error(`asset request failed (${response.status})`);
        const contentLength = Number(response.headers.get("content-length"));
        if (contentLength > MAX_FETCH_BYTES)
          throw new Error("asset exceeds audit limit");
        buffer = await readResponseBodyBounded(response, MAX_FETCH_BYTES);
        break;
      } catch (error) {
        lastError = error;
        if (!isRetryableNetworkError(error) || attempt === MAX_NETWORK_ATTEMPTS)
          throw error;
        await waitBeforeRetry(attempt);
      }
    }
    if (!buffer) throw lastError ?? new Error("asset download failed");
    const metadata = await sharp(buffer).metadata();
    const layout = detectSpriteAtlas(metadata.width, metadata.height);
    if (!layout || !metadata.width || !metadata.height) {
      return createAuditEntry(pet, {
        declaredVersion: pet.spriteVersionNumber,
        detectedVersion: null,
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        bytes: buffer.length,
        summary: null,
        error: "unsupported atlas dimensions",
        errorKind: "asset",
      });
    }
    const canonical = canonicalSpriteDimensions(layout.version);
    const raw = await sharp(buffer)
      .ensureAlpha()
      .resize({
        width: canonical.width,
        height: canonical.height,
        fit: "fill",
        kernel: sharp.kernel.nearest,
      })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return createAuditEntry(pet, {
      declaredVersion: pet.spriteVersionNumber,
      detectedVersion: layout.version,
      width: metadata.width,
      height: metadata.height,
      bytes: buffer.length,
      summary: summarizeAtlasPixels(raw.data, raw.info.width, layout.version),
      error:
        layout.version === pet.spriteVersionNumber
          ? null
          : "atlas dimensions disagree with declared sprite version",
      errorKind: layout.version === pet.spriteVersionNumber ? null : "asset",
    });
  } catch (error) {
    return createAuditEntry(pet, {
      declaredVersion: pet.spriteVersionNumber,
      detectedVersion: null,
      width: null,
      height: null,
      bytes: null,
      summary: null,
      error: errorMessage(error),
      errorKind: isRetryableNetworkError(error) ? "network" : "asset",
    });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const limit = Math.min(
    numberArg(args, "--limit", DEFAULT_WINDOW),
    MAX_WINDOW,
  );
  const concurrency = Math.min(numberArg(args, "--concurrency", 4), 12);
  const auditAll = args.includes("--all");
  const oldest = !auditAll;
  const auditInput = oldest
    ? { pets: await fetchOldestWindow(limit), source: SEARCH_URL }
    : await fetchManifest();
  const pets = auditInput.pets;
  const selected = pets.slice(0, oldest ? limit : undefined);
  const results: AtlasAuditEntry[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= selected.length) return;
        results[index] = await auditOne(selected[index]);
      }
    }),
  );

  const entries = results.map(toPublicAuditReviewEntry);
  const machineFlagCounts = entries.reduce<
    Partial<Record<MachineAuditFlag, number>>
  >((counts, entry) => {
    for (const flag of entry.machineFlags)
      counts[flag] = (counts[flag] ?? 0) + 1;
    return counts;
  }, {});
  const generatedAt = new Date().toISOString();
  const report = {
    generatedAt,
    scope: oldest ? "oldest-approved-window" : "manifest",
    source: auditInput.source,
    assetHost: TRUSTED_ASSET_HOST,
    requested: selected.length,
    summary: {
      errors: results.filter((entry) => entry.error !== null).length,
      networkErrors: results.filter((entry) => entry.errorKind === "network")
        .length,
      assetErrors: results.filter((entry) => entry.errorKind === "asset")
        .length,
      unsupportedDimensions: results.filter(
        (entry) => entry.error === "unsupported atlas dimensions",
      ).length,
      versionMismatches: results.filter((entry) =>
        entry.error?.includes("declared sprite version"),
      ).length,
      touchingFrames: results.reduce(
        (sum, entry) => sum + (entry.summary?.touchingFrames ?? 0),
        0,
      ),
      geometryOutliers: results.reduce(
        (sum, entry) => sum + (entry.summary?.geometryOutliers ?? 0),
        0,
      ),
      proportionOutliers: results.reduce(
        (sum, entry) => sum + (entry.summary?.proportionOutliers ?? 0),
        0,
      ),
      continuityOutliers: results.reduce(
        (sum, entry) => sum + (entry.summary?.continuityOutliers ?? 0),
        0,
      ),
      rowProportionOutliers: results.reduce(
        (sum, entry) => sum + (entry.summary?.rowProportionOutliers ?? 0),
        0,
      ),
      edgeTouches: results.reduce(
        (sum, entry) => ({
          left: sum.left + (entry.summary?.edgeTouches.left ?? 0),
          right: sum.right + (entry.summary?.edgeTouches.right ?? 0),
          top: sum.top + (entry.summary?.edgeTouches.top ?? 0),
          bottom: sum.bottom + (entry.summary?.edgeTouches.bottom ?? 0),
        }),
        { left: 0, right: 0, top: 0, bottom: 0 },
      ),
      machineFlagCounts,
      manualReviewPending: entries.length,
    },
    manualReviewRequired: MANUAL_REVIEW_CHECKS,
    manualReview: {
      status: "pending" as const,
      entries: entries.length,
      checks: MANUAL_REVIEW_CHECKS,
    },
  };

  const output = valueAfter(args, "--output");
  const reviewOutput = valueAfter(args, "--review-output");
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output) await writeFile(output, serialized, "utf8");
  else process.stdout.write(serialized);
  if (reviewOutput) {
    const reviewReport = buildPublicAuditReviewReport(
      results,
      oldest ? "oldest-approved-window" : "manifest",
      generatedAt,
      auditInput.source,
    );
    await writeFile(
      reviewOutput,
      `${JSON.stringify(reviewReport, null, 2)}\n`,
      "utf8",
    );
  }
}

if (import.meta.main) await main();
