import { getApprovedPetsForManifest } from "@/lib/pets";
import { keyFromR2PublicUrl, R2_PUBLIC_BASE } from "@/lib/r2-public-url";

export type LegacyManifestPet = {
  slug: string;
  displayName: string;
  kind: string;
  submittedBy: string | null;
  spritesheetUrl: string;
  petJsonUrl: string;
  zipUrl: string | null;
};

export type LegacyManifest = {
  generatedAt: string;
  total: number;
  pets: LegacyManifestPet[];
};

export type CompactManifestPet = [
  slug: string,
  displayName: string,
  kind: string,
  submittedBy: string | null,
  spritesheet: string,
  petJson: string,
  zip: string | null,
];

export type CompactManifest = {
  v: 2;
  generatedAt: string;
  total: number;
  assetBase: string;
  fields: [
    "slug",
    "displayName",
    "kind",
    "submittedBy",
    "spritesheet",
    "petJson",
    "zip",
  ];
  pets: CompactManifestPet[];
};

export async function buildLegacyManifest(): Promise<LegacyManifest> {
  const pets = await getApprovedPetsForManifest();
  const items: LegacyManifestPet[] = pets.map((pet) => ({
    slug: pet.slug,
    displayName: pet.displayName,
    kind: pet.kind,
    submittedBy: pet.creditName,
    spritesheetUrl: pet.spritesheetUrl,
    petJsonUrl: pet.petJsonUrl,
    zipUrl: pet.zipUrl ?? null,
  }));

  return {
    generatedAt: new Date().toISOString(),
    total: items.length,
    pets: items,
  };
}

export async function buildCompactManifest(): Promise<CompactManifest> {
  const pets = await getApprovedPetsForManifest();
  const items: CompactManifestPet[] = pets.map((pet) => [
    pet.slug,
    pet.displayName,
    pet.kind,
    pet.creditName,
    compactRequiredAssetRef(pet.spritesheetUrl),
    compactRequiredAssetRef(pet.petJsonUrl),
    compactOptionalAssetRef(pet.zipUrl),
  ]);

  return {
    v: 2,
    generatedAt: new Date().toISOString(),
    total: items.length,
    assetBase: R2_PUBLIC_BASE,
    fields: [
      "slug",
      "displayName",
      "kind",
      "submittedBy",
      "spritesheet",
      "petJson",
      "zip",
    ],
    pets: items,
  };
}

function compactRequiredAssetRef(raw: string): string {
  return keyFromR2PublicUrl(raw) ?? raw;
}

function compactOptionalAssetRef(raw: string | null): string | null {
  if (!raw) return null;
  return keyFromR2PublicUrl(raw) ?? raw;
}
