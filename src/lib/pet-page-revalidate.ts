import { withLocale } from "@/lib/locale-routing";

import { locales } from "@/i18n/config";

// Full-route ISR entries are not linked to data-cache tags: a pre-approval
// notFound() render, or a force-static page under its 24h ceiling, survives
// revalidateTag no matter how many tags flush. The /api/revalidate endpoint
// has always purged /pets/[slug] shapes for that reason; these helpers move
// that purge next to the write paths that actually change a pet's visibility
// (takedown, approval flip), which previously touched data caches only.
export async function revalidatePetPagePaths(
  ...slugs: string[]
): Promise<void> {
  try {
    const { revalidatePath } = await import("next/cache");
    for (const slug of slugs) {
      // localePrefix="as-needed": the default locale serves at /pets/x
      // while the rest serve prefixed. Purge every public shape.
      revalidatePath(`/pets/${slug}`);
      for (const locale of locales) {
        revalidatePath(withLocale(`/pets/${slug}`, locale));
      }
    }
  } catch {
    /* next/cache unavailable in some runtime contexts (tests, scripts) */
  }
}
