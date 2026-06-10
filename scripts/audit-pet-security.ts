import type { Readable } from "node:stream";

import { and, eq, inArray } from "drizzle-orm";
import JSZip from "jszip";

import * as schema from "@/lib/db/schema";
import {
  type PetSecurityScan,
  petSecurityPathSegment,
  petSecurityReason,
  scanPetManifestsSecurity,
  scanPetSecurity,
} from "@/lib/pet-security";
import { applySubmissionAction } from "@/lib/submission-decisions";
import type { ReviewChecks } from "@/lib/submission-review-types";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";

type Args = {
  apply: boolean;
  notify: boolean;
  includePending: boolean;
  json: boolean;
  limit: number;
  concurrency: number;
  timeoutMs: number;
  retries: number;
  delayMs: number;
  slug: string | null;
  manifestUrl: string | null;
};

type Row = {
  id: string;
  slug: string;
  status: "pending" | "approved" | "rejected";
  displayName: string;
  description: string;
  petJsonUrl: string;
  zipUrl: string | null;
};

type ZipPetJson = {
  name: string;
  petJson: unknown;
};

type AuditResult = {
  slug: string;
  status: Row["status"];
  decision: PetSecurityScan["decision"] | "error";
  reasons: string[];
  applied: boolean;
};

const MAX_PET_JSON_BYTES = 1024 * 1024;
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_PET_JSON_SCAN_ENTRIES = 16;
const MAX_ZIP_PET_JSON_TOTAL_BYTES = MAX_PET_JSON_BYTES;
const PUBLIC_MANIFEST_URL = "https://petdex.dev/api/manifest";

const args = parseArgs();
const results: AuditResult[] = [];

async function main() {
  if (args.apply && args.manifestUrl) {
    throw new Error("--apply requires DATABASE_URL mode, not --manifest-url");
  }
  const rows = await loadRows();

  log(
    `auditing ${rows.length} pets source=${args.manifestUrl ?? "database"} apply=${args.apply ? "YES" : "no"} notify=${args.notify ? "YES" : "no"} concurrency=${args.concurrency}`,
  );

  let nextIndex = 0;
  async function worker(workerId: number) {
    while (true) {
      const index = nextIndex++;
      if (index >= rows.length) return;
      const row = rows[index] as Row;
      const result = await auditRow(row);
      results.push(result);
      log(
        `[${index + 1}/${rows.length}] worker=${workerId} ${row.slug} ${result.status} -> ${result.decision}${result.applied ? " applied" : ""}${result.reasons[0] ? ` ${result.reasons[0]}` : ""}`,
      );
      if (args.delayMs > 0) await sleep(args.delayMs);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(args.concurrency, rows.length || 1) },
      (_, index) => worker(index + 1),
    ),
  );

  printSummary();
}

async function loadRows(): Promise<Row[]> {
  if (args.manifestUrl) return loadManifestRows(args.manifestUrl);

  const db = await getDb();
  const statuses: Row["status"][] = args.includePending
    ? ["approved", "pending"]
    : ["approved"];
  const where = args.slug
    ? and(
        eq(schema.submittedPets.slug, args.slug),
        inArray(schema.submittedPets.status, statuses),
      )
    : inArray(schema.submittedPets.status, statuses);

  const rows = await db
    .select({
      id: schema.submittedPets.id,
      slug: schema.submittedPets.slug,
      status: schema.submittedPets.status,
      displayName: schema.submittedPets.displayName,
      description: schema.submittedPets.description,
      petJsonUrl: schema.submittedPets.petJsonUrl,
      zipUrl: schema.submittedPets.zipUrl,
    })
    .from(schema.submittedPets)
    .where(where)
    .limit(args.limit);

  return rows as Row[];
}

async function loadManifestRows(url: string): Promise<Row[]> {
  const res = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  if (!res.ok) throw new Error(`manifest fetch ${res.status}`);
  const json = await res.json();
  const pets = isRecord(json) && Array.isArray(json.pets) ? json.pets : [];
  return pets.slice(0, args.limit).map((pet, index) => {
    if (!isRecord(pet)) throw new Error(`manifest pet ${index} is not object`);
    const slug = stringField(pet.slug) ?? `manifest-${index}`;
    return {
      id: slug,
      slug,
      status: "approved",
      displayName: stringField(pet.displayName) ?? slug,
      description: "",
      petJsonUrl: requiredStringField(
        pet.petJsonUrl,
        `pets[${index}].petJsonUrl`,
      ),
      zipUrl: stringField(pet.zipUrl),
    };
  });
}

function printSummary() {
  const fail = results.filter((result) => result.decision === "fail");
  const hold = results.filter((result) => result.decision === "hold");
  const error = results.filter((result) => result.decision === "error");
  const applied = results.filter((result) => result.applied);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          total: results.length,
          counts: {
            fail: fail.length,
            hold: hold.length,
            error: error.length,
            applied: applied.length,
          },
          fail,
          hold,
          error,
          applied,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("");
  console.log(
    `done total=${results.length} fail=${fail.length} hold=${hold.length} error=${error.length} applied=${applied.length}`,
  );

  for (const group of [
    ["fail", fail],
    ["hold", hold],
    ["error", error],
  ] as const) {
    if (group[1].length === 0) continue;
    console.log("");
    console.log(`${group[0]}:`);
    for (const result of group[1]) {
      console.log(
        `- ${result.slug} [${result.status}] ${result.reasons.join("; ")}`,
      );
    }
  }
}

async function auditRow(row: Row): Promise<AuditResult> {
  const metadataScan = scanPetSecurity({
    petJson: {},
    displayName: row.displayName,
    description: row.description,
  });
  const [fetched, zipFetched] = await Promise.all([
    fetchPetJson(row.petJsonUrl),
    fetchZipPetJson(row.zipUrl),
  ]);
  if (!fetched.ok && !zipFetched.ok) {
    if (metadataScan.decision === "pass") {
      return {
        slug: row.slug,
        status: row.status,
        decision: "error",
        reasons: [fetched.reason, zipFetched.reason],
        applied: false,
      };
    }
    const scan = {
      ...metadataScan,
      reasons: [
        ...metadataScan.reasons,
        `pet.json unavailable: ${fetched.reason}`,
        `zip pet.json unavailable: ${zipFetched.reason}`,
      ],
    };
    const applied = await maybeApplySecurityRejection(row, scan);
    return {
      slug: row.slug,
      status: row.status,
      decision: scan.decision,
      reasons: scan.reasons,
      applied,
    };
  }

  const unavailableReasons = [
    fetched.ok ? null : `pet.json unavailable: ${fetched.reason}`,
    zipFetched.ok ? null : `zip pet.json unavailable: ${zipFetched.reason}`,
  ].filter((reason): reason is string => Boolean(reason));
  const zipPetJsons = zipFetched.ok ? zipFetched.petJsons : [];
  const scan = scanPetManifestsSecurity({
    petJson: fetched.ok ? fetched.petJson : {},
    zipPetJson: zipPetJsons[0]?.petJson,
    displayName: row.displayName,
    description: row.description,
  });
  if (zipFetched.ok) scan.reasons.push(...zipFetched.reasons);
  for (const entry of zipPetJsons.slice(1)) {
    appendZipPetJsonScan(scan, entry);
  }
  if (scan.decision === "pass" && zipFetched.ok && zipFetched.reasons.length) {
    scan.decision = "hold";
  }
  if (scan.decision === "pass" && unavailableReasons.length > 0) {
    return {
      slug: row.slug,
      status: row.status,
      decision: "error",
      reasons: unavailableReasons,
      applied: false,
    };
  }
  if (unavailableReasons.length > 0) scan.reasons.push(...unavailableReasons);

  const applied = await maybeApplySecurityRejection(row, scan);

  return {
    slug: row.slug,
    status: row.status,
    decision: scan.decision,
    reasons: scan.reasons,
    applied,
  };
}

function appendZipPetJsonScan(scan: PetSecurityScan, entry: ZipPetJson) {
  const entryScan = scanPetSecurity({ petJson: entry.petJson });
  const entryName = petSecurityPathSegment(entry.name);
  scan.findings.push(
    ...entryScan.findings.map((finding) => ({
      ...finding,
      path: `zip.petJson[${JSON.stringify(entryName)}]${finding.path === "$" ? "" : finding.path.startsWith("$") ? finding.path.slice(1) : `.${finding.path}`}`,
    })),
  );
  scan.reasons.push(
    ...entryScan.findings.map(
      (finding) => `zip ${entryName}: ${finding.code}: ${finding.evidence}`,
    ),
  );
  if (entryScan.decision === "fail") scan.decision = "fail";
  if (scan.decision === "pass" && entryScan.decision === "hold") {
    scan.decision = "hold";
  }
}

async function maybeApplySecurityRejection(
  row: Row,
  scan: PetSecurityScan,
): Promise<boolean> {
  if (!args.apply || scan.decision !== "fail") return false;
  const db = await getDb();
  const actionDb = db as NonNullable<
    Parameters<typeof applySubmissionAction>[2]
  >["db"];
  const result = await applySubmissionAction(
    row.id,
    {
      action: "reject",
      reason:
        petSecurityReason(scan, "fail") ??
        "Pet metadata contains a high-confidence executable payload.",
    },
    { actor: "auto-review", db: actionDb, skipNotifications: !args.notify },
  );
  if (!result.ok) scan.reasons.unshift(result.body.error);
  await recordSecurityReview(
    row,
    scan,
    false,
    db,
    result.ok,
    result.ok ? null : result.body.error,
  );
  return result.ok;
}

async function fetchPetJson(
  url: string,
): Promise<{ ok: true; petJson: unknown } | { ok: false; reason: string }> {
  if (!isAllowedAssetUrl(url)) {
    return { ok: false, reason: "pet.json URL is not allowed" };
  }
  const fetched = await fetchBuffer(url, MAX_PET_JSON_BYTES);
  if (!fetched.ok) return fetched;
  try {
    return { ok: true, petJson: JSON.parse(fetched.buffer.toString("utf8")) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchZipPetJson(
  url: string | null,
): Promise<
  | { ok: true; petJsons: ZipPetJson[]; reasons: string[] }
  | { ok: false; reason: string }
> {
  if (!url) return { ok: false, reason: "zipUrl is missing" };
  if (!isAllowedAssetUrl(url)) {
    return { ok: false, reason: "zip URL is not allowed" };
  }
  const fetched = await fetchBuffer(url, MAX_ZIP_BYTES);
  if (!fetched.ok) return fetched;
  try {
    const archive = await JSZip.loadAsync(fetched.buffer);
    const names = Object.keys(archive.files).filter((name) => {
      const file = archive.files[name];
      return !file?.dir && name.split("/").pop() === "pet.json";
    });
    if (names.length === 0)
      return { ok: false, reason: "zip missing pet.json" };
    const reasons =
      names.length > 1 ? ["zip contains multiple pet.json files"] : [];
    const petJsons: ZipPetJson[] = [];
    let totalBytes = 0;
    for (const name of names) {
      if (petJsons.length >= MAX_ZIP_PET_JSON_SCAN_ENTRIES) {
        reasons.push("zip pet.json scan entry limit reached");
        break;
      }
      const entry = archive.files[name];
      const size = zipEntryUncompressedSize(entry);
      if (size !== null && totalBytes + size > MAX_ZIP_PET_JSON_TOTAL_BYTES) {
        reasons.push("zip pet.json total size exceeds audit scan limit");
        break;
      }
      const read = await readZipPetJson(entry, MAX_PET_JSON_BYTES);
      if (read.ok) {
        petJsons.push({ name, petJson: read.petJson });
        totalBytes += size ?? 0;
      } else {
        reasons.push(`zip ${name}: ${read.reason}`);
      }
    }
    if (petJsons.length === 0) {
      return {
        ok: false,
        reason: reasons.join("; ") || "zip pet.json could not be scanned",
      };
    }
    if (names.length > 1) {
      return { ok: true, petJsons, reasons };
    }
    return { ok: true, petJsons, reasons };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

type ZipEntryWithData = JSZip.JSZipObject & {
  _data?: { uncompressedSize?: unknown };
};

async function readZipPetJson(
  entry: JSZip.JSZipObject,
  maxBytes: number,
): Promise<{ ok: true; petJson: unknown } | { ok: false; reason: string }> {
  const size = zipEntryUncompressedSize(entry);
  if (size === null) {
    return { ok: false, reason: "zip pet.json size could not be verified" };
  }
  if (size > maxBytes) {
    return { ok: false, reason: "zip pet.json exceeds maximum audit size" };
  }
  const streamed = await readZipEntryBuffer(
    entry,
    maxBytes,
    "zip pet.json exceeds maximum audit size",
  );
  if (!streamed.ok) return streamed;
  try {
    const bytes = streamed.buffer;
    return { ok: true, petJson: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function readZipEntryBuffer(
  entry: JSZip.JSZipObject,
  maxBytes: number,
  sizeReason: string,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const stream = entry.nodeStream("nodebuffer") as Readable;
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (
      result: { ok: true; buffer: Buffer } | { ok: false; reason: string },
    ) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    stream.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        stream.destroy();
        finish({ ok: false, reason: sizeReason });
        return;
      }
      chunks.push(buffer);
    });
    stream.on("error", () => {
      finish({ ok: false, reason: "zip pet.json could not be read" });
    });
    stream.on("end", () => {
      finish({ ok: true, buffer: Buffer.concat(chunks, total) });
    });
  });
}

function zipEntryUncompressedSize(entry: JSZip.JSZipObject): number | null {
  const size = (entry as ZipEntryWithData)._data?.uncompressedSize;
  return typeof size === "number" && Number.isFinite(size) ? size : null;
}

async function fetchBuffer(
  url: string,
  maxBytes: number,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; reason: string }> {
  for (let attempt = 0; attempt <= args.retries; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(args.timeoutMs),
      });
      if (!res.ok) {
        if (shouldRetryStatus(res.status) && attempt < args.retries) {
          await sleep(retryDelayMs(attempt, res.headers));
          continue;
        }
        return { ok: false, reason: `pet.json fetch ${res.status}` };
      }
      const contentLength = Number(res.headers.get("content-length") ?? 0);
      if (contentLength > maxBytes) {
        return { ok: false, reason: "asset exceeds maximum audit size" };
      }
      return await readResponseBuffer(res, maxBytes);
    } catch (error) {
      if (attempt < args.retries) {
        await sleep(retryDelayMs(attempt));
        continue;
      }
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return { ok: false, reason: "asset fetch failed" };
}

async function readResponseBuffer(
  res: Response,
  maxBytes: number,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; reason: string }> {
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, reason: "asset response body is empty" };
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, reason: "asset exceeds maximum audit size" };
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return { ok: true, buffer: Buffer.concat(chunks, total) };
}

async function recordSecurityReview(
  row: Row,
  scan: PetSecurityScan,
  dryRun: boolean,
  db: Awaited<ReturnType<typeof getDb>>,
  applied: boolean,
  applyReason: string | null,
) {
  const now = new Date();
  const reviewId = `review_${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
  const checks: ReviewChecks = {
    security: scan,
    assets: { decision: "pass", reasons: [] },
    policy: {
      decision: "hold",
      confidence: 0,
      reasons: [
        "Policy review skipped after deterministic security rejection.",
      ],
      flags: [],
    },
    duplicates: {
      decision: "pass",
      reasons: [],
      exactMatches: [],
      visualMatches: [],
      semanticMatches: [],
      metadataMatches: [],
    },
    autopilot: { applied, dryRun, reason: applyReason },
  };

  await db.insert(schema.submissionReviews).values({
    id: reviewId,
    submittedPetId: row.id,
    status: "completed",
    decision: "auto_reject",
    reasonCode: "security_malicious_pet_json",
    summary:
      petSecurityReason(scan, "fail") ??
      "Pet metadata contains a high-confidence executable payload.",
    confidence: 100,
    checks,
    model: "deterministic-security-scan",
    dryRun,
    error: null,
    reviewedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

function parseArgs(): Args {
  const out: Args = {
    apply: false,
    notify: false,
    includePending: false,
    json: false,
    limit: 5000,
    concurrency: 16,
    timeoutMs: 5_000,
    retries: 2,
    delayMs: 0,
    slug: null,
    manifestUrl: null,
  };
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--apply") out.apply = true;
    else if (arg === "--notify") out.notify = true;
    else if (arg === "--include-pending") out.includePending = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--public") out.manifestUrl = PUBLIC_MANIFEST_URL;
    else if (arg === "--limit")
      out.limit = readNumber(argv[++index], out.limit);
    else if (arg === "--timeout-ms")
      out.timeoutMs = readNumber(argv[++index], out.timeoutMs);
    else if (arg === "--retries")
      out.retries = readNonNegativeNumber(argv[++index], out.retries);
    else if (arg === "--delay-ms")
      out.delayMs = readNonNegativeNumber(argv[++index], out.delayMs);
    else if (arg === "--concurrency") {
      out.concurrency = Math.min(
        Math.max(readNumber(argv[++index], out.concurrency), 1),
        32,
      );
    } else if (arg === "--slug") {
      out.slug = argv[++index] ?? null;
    } else if (arg === "--manifest-url") {
      out.manifestUrl = argv[++index] ?? null;
    }
  }
  return out;
}

function readNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readNonNegativeNumber(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function log(message: string) {
  if (!args.json) console.log(message);
}

async function getDb() {
  return (await import("@/lib/db/runtime")).runtimeDb;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function requiredStringField(value: unknown, path: string): string {
  const field = stringField(value);
  if (!field) throw new Error(`${path} is missing`);
  return field;
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function retryDelayMs(attempt: number, headers?: Headers): number {
  const retryAfter = headers?.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 4_000);
    }
  }
  return Math.min(500 * 2 ** attempt, 4_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
