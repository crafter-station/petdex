// All zips live on R2 now. Per-pet zips: pet.zipUrl in the DB. The
// "Download all pets" bundle: a single static URL pinned via env or a
// stable default.

import { R2_PUBLIC_BASE } from "@/lib/r2-public-url";

const DEFAULT_ALL_PACK_URL = `${R2_PUBLIC_BASE}/packs/petdex-approved.zip`;

export function getAllPetsPackPath(): string {
  return process.env.PETDEX_ALL_PETS_PACK_URL ?? DEFAULT_ALL_PACK_URL;
}
