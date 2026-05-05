import "server-only";

import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db/client";
import {
  posixInstallScript,
  posixNotFoundScript,
  powershellInstallScript,
  powershellNotFoundScript,
  type ResolvedPet,
} from "@/lib/install-script-render";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";

export {
  posixInstallScript,
  posixNotFoundScript,
  powershellInstallScript,
  powershellNotFoundScript,
  type ResolvedPet,
};

export async function resolveInstallablePet(
  slug: string,
  _origin: string,
): Promise<ResolvedPet | null> {
  const submitted = await db.query.submittedPets.findFirst({
    where: eq(schema.submittedPets.slug, slug),
  });
  if (!submitted || submitted.status !== "approved") return null;
  // Defense in depth — even if a legacy row slipped through with an
  // off-allowlist URL, the install script must never download from it.
  // Without this, an attacker-controlled host could serve a malicious
  // pet.json plus shell-injected URL chars to break out of the curl
  // single-quotes and execute commands on every viewer who pipes the
  // script through sh.
  if (
    !isAllowedAssetUrl(submitted.petJsonUrl) ||
    !isAllowedAssetUrl(submitted.spritesheetUrl)
  ) {
    return null;
  }
  return {
    slug,
    displayName: submitted.displayName,
    petJsonUrl: submitted.petJsonUrl,
    spritesheetUrl: submitted.spritesheetUrl,
    spriteExt: submitted.spritesheetUrl.endsWith(".png") ? "png" : "webp",
  };
}
