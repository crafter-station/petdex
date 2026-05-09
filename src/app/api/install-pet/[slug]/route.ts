/**
 * GET /api/install-pet/{slug}
 *
 * Returns JSON metadata describing where to download a pet's pack files.
 * Used by:
 *   - The web "Open in Petdex Desktop" button (to validate slug + show display name)
 *   - The desktop binary's URL scheme handler (petdex://install/{slug})
 *
 * Distinct from /install/{slug} which serves a shell script for `curl | sh`
 * style installs. This one is a typed JSON contract for programmatic clients.
 */
import { resolveInstallablePet } from "@/lib/install-script";
import { installCounterRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { slug: string };

export async function GET(
  req: Request,
  ctx: { params: Promise<Params> },
): Promise<Response> {
  const { slug } = await ctx.params;
  const origin = new URL(req.url).origin;

  // Slug shape gate before hitting the DB. Defends against odd inputs and
  // gives a clean 400 instead of 404 for nonsense.
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    return Response.json(
      { ok: false, error: "invalid_slug" },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const pet = await resolveInstallablePet(slug, origin);
  if (!pet) {
    return Response.json(
      { ok: false, error: "not_found", slug },
      { status: 404, headers: { "cache-control": "no-store" } },
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
        "cache-control": "public, max-age=60",
        "content-type": "application/json",
      },
    },
  );
}
