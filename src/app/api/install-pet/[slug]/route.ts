/**
 * GET /api/install-pet/{slug}
 *
 * Returns JSON metadata describing where to download a pet's pack files.
 * Used by:
 *   - The web "Open in Petdex Desktop" button (to validate slug + show display name)
 *   - The desktop binary's URL scheme handler (`petdex://<slug>` and `petdex://install?...`)
 *
 * Distinct from /install/{slug} which serves a shell script for `curl | sh`
 * style installs. This one is a typed JSON contract for programmatic clients.
 */
import { resolveInstallablePet } from "@/lib/install-script";
import { installCounterRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { slug: string };

const INSTALL_INVALID_SLUG_CACHE_CONTROL =
  "public, max-age=60, s-maxage=120, stale-while-revalidate=300";
const INSTALL_DB_MISS_CACHE_CONTROL = "private, no-store";
const INSTALL_SUCCESS_CACHE_CONTROL = "private, no-store";
const INSTALL_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function GET(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const { slug } = await ctx.params;
  const origin = new URL(req.url).origin;

  // Slug shape gate before hitting the DB. Defends against odd inputs and
  // gives a clean 400 instead of 404 for nonsense.
  if (!INSTALL_SLUG_RE.test(slug)) {
    return Response.json(
      { ok: false, error: "invalid_slug" },
      {
        status: 400,
        headers: { "cache-control": INSTALL_INVALID_SLUG_CACHE_CONTROL },
      },
    );
  }

  const pet = await resolveInstallablePet(slug, origin);
  if (!pet) {
    return Response.json(
      { ok: false, error: "not_found", slug },
      {
        status: 404,
        headers: { "cache-control": INSTALL_DB_MISS_CACHE_CONTROL },
      },
    );
  }

  // Rate-limited fire-and-forget metric (mirror the script endpoint).
  void (async () => {
    const xff = req.headers.get("x-forwarded-for") ?? "";
    const ip = xff.split(",")[0]?.trim() || "anon";
    const { success } = await installCounterRatelimit.limit(ip);
    if (success) {
      const { incrementInstallCount } = await import("@/lib/db/metrics");
      await incrementInstallCount(slug).catch(() => {});
    }
  })();

  return Response.json(
    {
      ok: true,
      pet: {
        slug: pet.slug,
        displayName: pet.displayName,
        petJsonUrl: pet.petJsonUrl,
        spritesheetUrl: pet.spritesheetUrl,
        spriteExt: pet.spriteExt,
      },
    },
    {
      status: 200,
      headers: {
        "cache-control": INSTALL_SUCCESS_CACHE_CONTROL,
        "content-type": "application/json",
      },
    },
  );
}
