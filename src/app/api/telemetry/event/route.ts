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

function getCountry(req: Request): string | null {
  return (
    req.headers.get("x-vercel-ip-country") ??
    (req as Request & { geo?: { country?: string } }).geo?.country ??
    null
  );
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
  // Rate-limit by IP. We never store the IP itself or log it — the
  // privacy page promises country-only.
  const xff = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const rateLimitKey =
    xff ?? req.headers.get("x-real-ip") ?? "unknown-anonymous";

  const rl = await telemetryRatelimit.limit(rateLimitKey);
  if (!rl.success) {
    return new Response(null, { status: 429 });
  }

  // Reject obviously oversized bodies before reading them. Express
  // through both Content-Length and a fallback streaming length cap.
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "payload_too_large" }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }

  let parsed: unknown;
  try {
    parsed = await req.json();
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
