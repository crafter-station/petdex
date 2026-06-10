import { incrementInstallCount } from "@/lib/db/metrics";
import {
  posixInstallScript,
  posixNotFoundScript,
  powershellInstallScript,
  powershellNotFoundScript,
  resolveInstallablePet,
} from "@/lib/install-script";
import { installCounterRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { locale: string; slug: string };

const INSTALL_INVALID_SLUG_CACHE_CONTROL =
  "public, max-age=60, s-maxage=120, stale-while-revalidate=300";
const INSTALL_DB_MISS_CACHE_CONTROL = "private, no-store";
const INSTALL_SUCCESS_CACHE_CONTROL = "private, no-store";
const INSTALL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INSTALL_SCRIPT_VARY = "User-Agent";

function detectPlatformFromRequest(req: Request): "posix" | "ps1" {
  const url = new URL(req.url);
  const explicit = url.searchParams.get("platform")?.toLowerCase();
  if (
    explicit === "ps1" ||
    explicit === "windows" ||
    explicit === "powershell"
  ) {
    return "ps1";
  }
  if (explicit === "posix" || explicit === "sh" || explicit === "unix") {
    return "posix";
  }
  // Heuristic: PowerShell sends User-Agent like "WindowsPowerShell/..."
  const ua = req.headers.get("user-agent") ?? "";
  if (/PowerShell|WindowsPowerShell/i.test(ua)) return "ps1";
  return "posix";
}

export async function GET(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const { slug } = await ctx.params;
  const origin = new URL(req.url).origin;
  const platform = detectPlatformFromRequest(req);

  if (!INSTALL_SLUG_RE.test(slug)) {
    const body =
      platform === "ps1"
        ? powershellNotFoundScript(slug)
        : posixNotFoundScript(slug);
    return new Response(body, {
      status: 404,
      headers: {
        "Content-Type":
          platform === "ps1"
            ? "text/plain; charset=utf-8"
            : "text/plain; charset=utf-8",
        "Cache-Control": INSTALL_INVALID_SLUG_CACHE_CONTROL,
        Vary: INSTALL_SCRIPT_VARY,
      },
    });
  }

  const pet = await resolveInstallablePet(slug, origin);
  if (!pet) {
    const body =
      platform === "ps1"
        ? powershellNotFoundScript(slug)
        : posixNotFoundScript(slug);
    return new Response(body, {
      status: 404,
      headers: {
        "Content-Type":
          platform === "ps1"
            ? "text/plain; charset=utf-8"
            : "text/plain; charset=utf-8",
        "Cache-Control": INSTALL_DB_MISS_CACHE_CONTROL,
        Vary: INSTALL_SCRIPT_VARY,
      },
    });
  }

  // Fire-and-forget metric increment (don't block the script response).
  // We rate-limit by IP first so a bash loop can't inflate any pet's
  // install count to game the 'Most installed' sort.
  void (async () => {
    const xff = req.headers.get("x-forwarded-for") ?? "";
    const ip = xff.split(",")[0]?.trim() || "anon";
    const { success } = await installCounterRatelimit.limit(ip);
    if (success) {
      await incrementInstallCount(slug).catch(() => {});
    }
  })();

  const body =
    platform === "ps1" ? powershellInstallScript(pet) : posixInstallScript(pet);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type":
        platform === "ps1"
          ? "text/plain; charset=utf-8"
          : "text/x-shellscript; charset=utf-8",
      "Cache-Control": INSTALL_SUCCESS_CACHE_CONTROL,
      Vary: INSTALL_SCRIPT_VARY,
    },
  });
}
