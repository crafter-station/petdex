import { createHmac, timingSafeEqual } from "node:crypto";

import { sql } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import {
  type RouteCostKind,
  type RouteCostReferrerSource,
  type RouteCostTrafficSource,
  routeCostSecret,
} from "@/lib/route-cost";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2048;
const KIND_SET = new Set<RouteCostKind>([
  "api",
  "asset-api",
  "metadata",
  "page",
]);
const METHOD_SET = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const REFERRER_SOURCE_SET = new Set<RouteCostReferrerSource>([
  "direct",
  "external",
  "internal",
  "search",
  "social",
  "unknown",
]);
const TRAFFIC_SOURCE_SET = new Set<RouteCostTrafficSource>([
  "bot",
  "browser",
  "monitor",
  "prefetch",
  "preview",
  "unknown",
]);

type Body = {
  at?: unknown;
  method?: unknown;
  referrerSource?: unknown;
  route?: unknown;
  routeKind?: unknown;
  sampleWeight?: unknown;
  trafficSource?: unknown;
};

class PayloadTooLargeError extends Error {
  constructor() {
    super("payload_too_large");
  }
}

export async function POST(req: Request): Promise<Response> {
  const secret = routeCostSecret();
  if (!secret) return new Response(null, { status: 404 });

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }

  let bodyText: string;
  try {
    bodyText = await readBodyCapped(req.body, MAX_BODY_BYTES);
  } catch (err) {
    if (!(err instanceof PayloadTooLargeError)) throw err;
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }

  if (
    !verifySignature(bodyText, secret, req.headers.get("x-petdex-signature"))
  ) {
    return new Response(null, { status: 404 });
  }

  let body: Body;
  try {
    body = JSON.parse(bodyText) as Body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = parseBody(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    await db
      .insert(schema.routeCostBuckets)
      .values({
        bucketStart: parsed.data.bucketStart,
        method: parsed.data.method,
        route: parsed.data.route,
        routeKind: parsed.data.routeKind,
        sampleCount: 1,
        estimatedRequests: parsed.data.sampleWeight,
      })
      .onConflictDoUpdate({
        target: [
          schema.routeCostBuckets.bucketStart,
          schema.routeCostBuckets.method,
          schema.routeCostBuckets.routeKind,
          schema.routeCostBuckets.route,
        ],
        set: {
          sampleCount: sql`${schema.routeCostBuckets.sampleCount} + 1`,
          estimatedRequests: sql`${schema.routeCostBuckets.estimatedRequests} + ${parsed.data.sampleWeight}`,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    console.error(
      "[route-cost] upsert failed:",
      err instanceof Error ? err.message : "unknown error",
    );
  }

  try {
    await db
      .insert(schema.routeCostSourceBuckets)
      .values({
        bucketStart: parsed.data.bucketStart,
        method: parsed.data.method,
        referrerSource: parsed.data.referrerSource,
        route: parsed.data.route,
        routeKind: parsed.data.routeKind,
        trafficSource: parsed.data.trafficSource,
        sampleCount: 1,
        estimatedRequests: parsed.data.sampleWeight,
      })
      .onConflictDoUpdate({
        target: [
          schema.routeCostSourceBuckets.bucketStart,
          schema.routeCostSourceBuckets.method,
          schema.routeCostSourceBuckets.routeKind,
          schema.routeCostSourceBuckets.route,
          schema.routeCostSourceBuckets.trafficSource,
          schema.routeCostSourceBuckets.referrerSource,
        ],
        set: {
          sampleCount: sql`${schema.routeCostSourceBuckets.sampleCount} + 1`,
          estimatedRequests: sql`${schema.routeCostSourceBuckets.estimatedRequests} + ${parsed.data.sampleWeight}`,
          updatedAt: new Date(),
        },
      });
  } catch (err) {
    console.error(
      "[route-cost-source] upsert failed:",
      err instanceof Error ? err.message : "unknown error",
    );
  }

  return new Response(null, { status: 204 });
}

async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let total = 0;
  let out = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PayloadTooLargeError();
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return out;
}

function parseBody(body: Body):
  | {
      ok: true;
      data: {
        bucketStart: Date;
        method: string;
        referrerSource: RouteCostReferrerSource;
        route: string;
        routeKind: RouteCostKind;
        sampleWeight: number;
        trafficSource: RouteCostTrafficSource;
      };
    }
  | { ok: false; error: string } {
  const route =
    typeof body.route === "string" && body.route.startsWith("/")
      ? body.route.slice(0, 180)
      : null;
  const method =
    typeof body.method === "string" ? body.method.toUpperCase() : null;
  const routeKind =
    typeof body.routeKind === "string" &&
    KIND_SET.has(body.routeKind as RouteCostKind)
      ? (body.routeKind as RouteCostKind)
      : null;
  const referrerSource =
    typeof body.referrerSource === "string" &&
    REFERRER_SOURCE_SET.has(body.referrerSource as RouteCostReferrerSource)
      ? (body.referrerSource as RouteCostReferrerSource)
      : "unknown";
  const trafficSource =
    typeof body.trafficSource === "string" &&
    TRAFFIC_SOURCE_SET.has(body.trafficSource as RouteCostTrafficSource)
      ? (body.trafficSource as RouteCostTrafficSource)
      : "unknown";
  const at = typeof body.at === "string" ? new Date(body.at) : new Date();
  const sampleWeight =
    typeof body.sampleWeight === "number" &&
    Number.isFinite(body.sampleWeight) &&
    body.sampleWeight >= 1 &&
    body.sampleWeight <= 1_000_000
      ? Math.round(body.sampleWeight)
      : null;

  if (!route) return { ok: false, error: "invalid_route" };
  if (!method || !METHOD_SET.has(method))
    return { ok: false, error: "invalid_method" };
  if (!routeKind) return { ok: false, error: "invalid_route_kind" };
  if (!Number.isFinite(at.getTime())) return { ok: false, error: "invalid_at" };
  if (!sampleWeight) return { ok: false, error: "invalid_sample_weight" };

  return {
    ok: true,
    data: {
      bucketStart: bucketStart(at),
      method,
      referrerSource,
      route,
      routeKind,
      sampleWeight,
      trafficSource,
    },
  };
}

function bucketStart(date: Date): Date {
  const bucketMs = 15 * 60 * 1000;
  return new Date(Math.floor(date.getTime() / bucketMs) * bucketMs);
}

function verifySignature(
  body: string,
  secret: string,
  signature: string | null,
): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
