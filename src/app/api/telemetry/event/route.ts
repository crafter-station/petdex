import { createHmac } from "node:crypto";

import { normalizeCountry } from "@/lib/country-code";
import { db, schema } from "@/lib/db/client";
import { telemetryRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_EVENTS = new Set([
  "cli_install_desktop_success",
  "cli_hooks_install_success",
  "cli_desktop_start_success",
  "desktop_first_state_received",
]);

const VALID_OS = new Set(["darwin", "linux", "win32"]);
const VALID_ARCH = new Set(["arm64", "x64"]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMVER_RE = /^\d+\.\d+\.\d+/;

// Hard caps so a malicious payload can't blow up storage or downstream
// summary queries. The endpoint is public + unauthenticated.
const MAX_VERSION_LEN = 64;
const MAX_AGENTS = 8;
const MAX_AGENT_LEN = 64;
const MAX_STATE_LEN = 64;
const MAX_AGENT_SOURCE_LEN = 64;
const MAX_BODY_BYTES = 4096;

type RawBody = Record<string, unknown>;

class PayloadTooLargeError extends Error {
  constructor() {
    super("payload_too_large");
  }
}

/**
 * Read a ReadableStream into a UTF-8 string while enforcing a hard
 * byte cap. Aborts the stream the moment we exceed `maxBytes` so a
 * chunked / unlabeled body can't force the runtime to buffer the
 * whole payload before validation.
 */
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
        try {
          await reader.cancel();
        } catch {
          // best-effort
        }
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

// Validate the country header against ISO 3166-1 alpha-2 to keep
// junk/spoofed values out of the admin geo dashboard. See
// src/lib/country-code.ts for rationale and tests.
function getCountry(req: Request): string | null {
  const raw =
    req.headers.get("x-vercel-ip-country") ??
    (req as Request & { geo?: { country?: string } }).geo?.country ??
    null;
  return normalizeCountry(raw);
}

/**
 * Hash an IP into a rate-limit key with a server-side secret so the
 * value Upstash persists is not the IP itself. Two IPs from different
 * users get different keys, so per-IP rate limiting still works, but
 * an attacker with Redis access can't enumerate IP -> request count.
 *
 * Resolution order:
 *   1. TELEMETRY_RATELIMIT_SECRET — explicit per-deployment secret.
 *   2. UPSTASH_REDIS_REST_TOKEN — already deploy-stable on Vercel,
 *      every prod deploy has it (the rate limiter doesn't work
 *      without it), so deriving from it gives us a stable hash
 *      across cold starts/instances without forcing a new env var.
 *   3. process.pid + Date.now() — dev-only fallback. In a serverless
 *      deployment this would multiply rate-limit windows by the
 *      number of active instances and reset on deploy, so we throw
 *      in production rather than silently degrade. Hot-reload in
 *      `next dev` is the only place this branch fires.
 */
const RATE_LIMIT_SECRET = (() => {
  const fromEnv = process.env.TELEMETRY_RATELIMIT_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (upstashToken && upstashToken.length >= 16) {
    // Derive instead of using the token directly so a Redis-side
    // dump can't trivially deanonymize IPs even with the token —
    // the attacker would need to know the derivation suffix too.
    return createHmac("sha256", upstashToken)
      .update("petdex-telemetry-rate-limit-v1")
      .digest("hex");
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "TELEMETRY_RATELIMIT_SECRET (or UPSTASH_REDIS_REST_TOKEN) must be set in production. " +
        "Without a stable secret, every cold start writes Redis keys for the same IP under " +
        "a different hash, multiplying the 60/min ingestion limit by the number of active " +
        "serverless instances and resetting on deploy.",
    );
  }
  // Dev-only fallback. Rate limiter falls back to in-memory in dev
  // anyway (no Upstash creds), so per-process keys are fine.
  return createHmac("sha256", "petdex-telemetry-fallback")
    .update(`${process.pid}:${Date.now()}`)
    .digest("hex");
})();

function hashIpForRateLimit(ip: string): string {
  return createHmac("sha256", RATE_LIMIT_SECRET).update(ip).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clipString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, max)
    : null;
}

function validate(body: unknown):
  | {
      ok: true;
      data: {
        installId: string;
        event: string;
        cliVersion: string | null;
        binaryVersion: string | null;
        os: string | null;
        arch: string | null;
        agents: string[] | null;
        state: string | null;
        agentSource: string | null;
      };
    }
  | { ok: false; error: string } {
  if (!isPlainObject(body)) {
    return { ok: false, error: "body must be a JSON object" };
  }

  const installId = body.install_id;
  if (typeof installId !== "string" || !UUID_RE.test(installId)) {
    return { ok: false, error: "install_id must be a UUID v4" };
  }

  const event = body.event;
  if (typeof event !== "string" || !VALID_EVENTS.has(event)) {
    return {
      ok: false,
      error: `event must be one of: ${[...VALID_EVENTS].join(", ")}`,
    };
  }

  // Versions must be semver-shaped AND short. The regex caps the prefix
  // but a string like "1.2.3" + 1 MB of trailing garbage still matches
  // the prefix; clip explicitly.
  const cliVersionRaw = clipString(body.cli_version, MAX_VERSION_LEN);
  const cliVersion =
    cliVersionRaw && SEMVER_RE.test(cliVersionRaw) ? cliVersionRaw : null;

  const binaryVersionRaw = clipString(body.binary_version, MAX_VERSION_LEN);
  const binaryVersion =
    binaryVersionRaw && SEMVER_RE.test(binaryVersionRaw)
      ? binaryVersionRaw
      : null;

  const os =
    typeof body.os === "string" && VALID_OS.has(body.os) ? body.os : null;
  const arch =
    typeof body.arch === "string" && VALID_ARCH.has(body.arch)
      ? body.arch
      : null;

  let agents: string[] | null = null;
  if (Array.isArray(body.agents)) {
    agents = body.agents
      .filter((a): a is string => typeof a === "string")
      .slice(0, MAX_AGENTS)
      .map((a) => a.slice(0, MAX_AGENT_LEN));
    if (agents.length === 0) agents = null;
  }

  const state = clipString(body.state, MAX_STATE_LEN);
  const agentSource = clipString(body.agent_source, MAX_AGENT_SOURCE_LEN);

  return {
    ok: true,
    data: {
      installId,
      event,
      cliVersion,
      binaryVersion,
      os,
      arch,
      agents,
      state,
      agentSource,
    },
  };
}

export async function POST(req: Request): Promise<Response> {
  // Rate-limit by IP, but hash it before handing to Upstash so the
  // Redis key isn't a literal IP — the privacy page promises raw IPs
  // are never stored, and "stored in our rate-limit cache" still
  // counts as stored. With a per-deploy server secret the hash is
  // also non-trivial to reverse via rainbow table.
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = xff ?? req.headers.get("x-real-ip") ?? "unknown-anonymous";
  const rateLimitKey = hashIpForRateLimit(ip);

  const rl = await telemetryRatelimit.limit(rateLimitKey);
  if (!rl.success) {
    return new Response(null, { status: 429 });
  }

  // Cheap upfront reject when the client advertises an oversized body.
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "payload_too_large" }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }

  // Stream-cap fallback: chunked or unlabeled bodies don't have
  // Content-Length, so a malicious client can still force the runtime
  // to buffer a multi-MB body before validation runs. Read the stream
  // ourselves and abort the moment we cross MAX_BODY_BYTES.
  let bodyText: string;
  try {
    bodyText = await readBodyCapped(req.body, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      return new Response(JSON.stringify({ error: "payload_too_large" }), {
        status: 413,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "invalid_body" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  let parsed: unknown;
  try {
    parsed = bodyText.length === 0 ? null : JSON.parse(bodyText);
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const result = validate(parsed);
  if (!result.ok) {
    return new Response(JSON.stringify({ error: result.error }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const country = getCountry(req);

  try {
    await db.insert(schema.telemetryEvents).values({
      installId: result.data.installId,
      event: result.data.event,
      cliVersion: result.data.cliVersion,
      binaryVersion: result.data.binaryVersion,
      os: result.data.os,
      arch: result.data.arch,
      agents: result.data.agents,
      state: result.data.state,
      agentSource: result.data.agentSource,
      country,
    });
  } catch (err) {
    // Swallow DB errors but log a sanitized message — never the IP, and
    // never the raw body (which could carry user-controlled strings).
    console.error(
      "[telemetry] insert failed:",
      err instanceof Error ? err.message : "unknown error",
    );
    return new Response(null, { status: 204 });
  }

  return new Response(null, { status: 204 });
}
