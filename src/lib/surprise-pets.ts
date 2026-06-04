export type SurprisePet = {
  slug: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
  href: string;
  installHref: string;
};

type SurprisePetSource = {
  slug: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
};

export function toSurprisePet(pet: SurprisePetSource): SurprisePet {
  return {
    slug: pet.slug,
    displayName: pet.displayName,
    description: pet.description,
    spritesheetPath: pet.spritesheetPath,
    href: `/pets/${pet.slug}`,
    installHref: `/install/${pet.slug}`,
  };
}
