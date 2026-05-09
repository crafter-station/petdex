import { db } from "@/lib/db/client";
import { schema } from "@/lib/db/client";
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

type RawBody = Record<string, unknown>;

function getIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  );
}

function getCountry(req: Request): string | null {
  return (
    req.headers.get("x-vercel-ip-country") ??
    (req as Request & { geo?: { country?: string } }).geo?.country ??
    null
  );
}

function validate(body: RawBody):
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

  const cliVersion =
    typeof body.cli_version === "string" && SEMVER_RE.test(body.cli_version)
      ? body.cli_version
      : null;

  const binaryVersion =
    typeof body.binary_version === "string" &&
    SEMVER_RE.test(body.binary_version)
      ? body.binary_version
      : null;

  const os =
    typeof body.os === "string" && VALID_OS.has(body.os) ? body.os : null;

  const arch =
    typeof body.arch === "string" && VALID_ARCH.has(body.arch)
      ? body.arch
      : null;

  let agents: string[] | null = null;
  if (Array.isArray(body.agents)) {
    agents = body.agents.filter((a): a is string => typeof a === "string");
  }

  const state =
    typeof body.state === "string" ? body.state.slice(0, 256) : null;

  const agentSource =
    typeof body.agent_source === "string"
      ? body.agent_source.slice(0, 128)
      : null;

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
  const ip = getIp(req);

  const rl = await telemetryRatelimit.limit(ip);
  if (!rl.success) {
    return new Response(null, { status: 429 });
  }

  let body: RawBody;
  try {
    body = (await req.json()) as RawBody;
  } catch {
    console.warn("[telemetry] invalid JSON from", ip);
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const result = validate(body);
  if (!result.ok) {
    console.warn("[telemetry] validation failed:", result.error, "ip:", ip);
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
    console.error("[telemetry] insert failed:", err);
    return new Response(null, { status: 204 });
  }

  return new Response(null, { status: 204 });
}
