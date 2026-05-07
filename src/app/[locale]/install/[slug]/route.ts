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
      "Cache-Control": "public, max-age=30",
    },
  });
}
