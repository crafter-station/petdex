import {
  collectionPetLimitExceeded,
  MAX_COLLECTION_PETS,
  MAX_OWNER_COLLECTIONS,
} from "@/lib/collection-constants";
import {
  collectionInputErrorCode,
  isCollectionRequestBody,
  MAX_COLLECTION_DESCRIPTION,
  MAX_COLLECTION_TITLE,
  normalizeCollectionCover,
  normalizeCollectionExternalUrl,
  normalizeCollectionInput,
  normalizeCollectionPatch,
  resolveCollectionCover,
} from "@/lib/collection-input";
import {
  type CollectionListingSortKey,
  sortCollectionListingItems,
} from "@/lib/collection-listing-order";
import {
  COLLECTION_SLUG_ATTEMPTS,
  collectionSlugBase,
  slugify,
} from "@/lib/collection-slug";
import type { PetCollectionWithPets } from "@/lib/collections";
import { validateProfileHandle } from "@/lib/profiles";

export type { CollectionListingSortKey, PetCollectionWithPets };

export type CollectionLimits = {
  readonly maxOwnerCollections: number;
  readonly maxPetsPerCollection: number;
  readonly maxTitleLength: number;
  readonly maxDescriptionLength: number;
  readonly slugAttempts: number;
};

export type CollectionValidationErrorCode =
  | "invalid_body"
  | "title_length"
  | "description_type"
  | "description_length"
  | "pet_slug"
  | "pet_slugs"
  | "collection_pet_limit"
  | "external_url"
  | "cover_pet_slug";

export type CollectionValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: CollectionValidationErrorCode };

export type ValidatedCreateCollectionInput = {
  title: string;
  description: string;
  petSlugs: string[];
  externalUrl: string | null;
  coverPetSlug: string | null;
  allApproved: boolean;
};

export type ValidatedUpdateCollectionInput = {
  title?: string;
  description?: string;
  petSlugs?: string[];
  externalUrl?: string | null;
  coverPetSlug?: string | null;
  allApproved?: boolean;
};

export type ValidateUpdateCollectionOptions = {
  existingPetSlugs?: readonly string[];
  existingCoverPetSlug?: string | null;
};

export type CollectionListingSortable = {
  slug: string;
  title: string;
  petCount: number;
};

export type OwnerCollectionSummary = PetCollectionWithPets & {
  petCount: number;
};

export type CollectionsStorePort = {
  getPublicBySlug(
    slug: string,
    limit?: number,
  ): Promise<PetCollectionWithPets | null>;
  listPublicBySlugs(
    slugs: readonly string[],
    limit?: number,
  ): Promise<PetCollectionWithPets[]>;
  listOwnerCollections(
    ownerId: string,
    petsPerPreview?: number | null,
  ): Promise<OwnerCollectionSummary[]>;
};

export type CollectionsModuleDeps = {
  store?: CollectionsStorePort;
};

export type CollectionsModule = {
  readonly limits: CollectionLimits;
  validateCreateInput(
    raw: unknown,
  ): CollectionValidationResult<ValidatedCreateCollectionInput>;
  validateUpdateInput(
    raw: unknown,
    options?: ValidateUpdateCollectionOptions,
  ): CollectionValidationResult<ValidatedUpdateCollectionInput>;
  buildSlug(title: string): string;
  isReservedSlug(slug: string): boolean;
  sortListings<T extends CollectionListingSortable>(
    items: readonly T[],
    sort?: CollectionListingSortKey,
  ): T[];
  getPublicBySlug(
    slug: string,
    limit?: number,
  ): Promise<PetCollectionWithPets | null>;
  listPublicBySlugs(
    slugs: readonly string[],
    limit?: number,
  ): Promise<PetCollectionWithPets[]>;
  listOwnerCollections(
    ownerId: string,
    petsPerPreview?: number | null,
  ): Promise<OwnerCollectionSummary[]>;
};

const COLLECTION_LIMITS: CollectionLimits = Object.freeze({
  maxOwnerCollections: MAX_OWNER_COLLECTIONS,
  maxPetsPerCollection: MAX_COLLECTION_PETS,
  maxTitleLength: MAX_COLLECTION_TITLE,
  maxDescriptionLength: MAX_COLLECTION_DESCRIPTION,
  slugAttempts: COLLECTION_SLUG_ATTEMPTS,
});

function toValidationErrorCode(error: unknown): CollectionValidationErrorCode {
  return collectionInputErrorCode(error) as CollectionValidationErrorCode;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit) || limit < 0) return 0;
  return Math.floor(limit);
}

function applyPetLimit(
  collection: PetCollectionWithPets,
  limit: number | undefined,
): PetCollectionWithPets {
  if (limit === undefined || collection.pets.length <= limit) {
    return collection;
  }
  return {
    ...collection,
    pets: collection.pets.slice(0, limit),
  };
}

function createDefaultCollectionsStore(): CollectionsStorePort {
  return {
    async getPublicBySlug(slug) {
      const { getCollection } = await import("@/lib/collections");
      return getCollection(slug);
    },
    async listPublicBySlugs(slugs, limit) {
      const { getCollectionsBySlugs } = await import("@/lib/collections");
      return getCollectionsBySlugs([...slugs], limit);
    },
    async listOwnerCollections(ownerId, petsPerPreview) {
      const { getOwnerCollections } = await import("@/lib/collections");
      return getOwnerCollections(ownerId, petsPerPreview);
    },
  };
}

export function createCollectionsModule(
  deps: CollectionsModuleDeps = {},
): CollectionsModule {
  const store = deps.store ?? createDefaultCollectionsStore();

  return {
    limits: COLLECTION_LIMITS,

    validateCreateInput(raw) {
      if (!isCollectionRequestBody(raw)) {
        return { ok: false, error: "invalid_body" };
      }

      let normalized: ReturnType<typeof normalizeCollectionInput>;
      try {
        normalized = normalizeCollectionInput({
          title: raw.title,
          description: raw.description,
          petSlugs: raw.petSlugs,
        });
      } catch (error) {
        return { ok: false, error: toValidationErrorCode(error) };
      }

      if (collectionPetLimitExceeded(normalized.petSlugs, null)) {
        return { ok: false, error: "collection_pet_limit" };
      }

      const externalUrl = normalizeCollectionExternalUrl(raw.externalUrl);
      if (externalUrl === false) {
        return { ok: false, error: "external_url" };
      }

      const hasCover = "coverPetSlug" in raw && raw.coverPetSlug !== undefined;
      let requestedCover: string | null | undefined;
      if (hasCover) {
        const normalizedCover = normalizeCollectionCover(raw.coverPetSlug);
        if (normalizedCover === false) {
          return { ok: false, error: "cover_pet_slug" };
        }
        requestedCover = normalizedCover;
      }

      const coverPetSlug = resolveCollectionCover(
        requestedCover,
        normalized.petSlugs,
        null,
      );

      return {
        ok: true,
        value: {
          title: normalized.title,
          description: normalized.description,
          petSlugs: normalized.petSlugs,
          externalUrl,
          coverPetSlug,
          allApproved: raw.allApproved === true,
        },
      };
    },

    validateUpdateInput(raw, options) {
      if (!isCollectionRequestBody(raw)) {
        return { ok: false, error: "invalid_body" };
      }

      let patch: ReturnType<typeof normalizeCollectionPatch>;
      try {
        patch = normalizeCollectionPatch({
          title: raw.title,
          description: raw.description,
          petSlugs: raw.petSlugs,
        });
      } catch (error) {
        return { ok: false, error: toValidationErrorCode(error) };
      }

      if (
        patch.petSlugs !== undefined &&
        collectionPetLimitExceeded(
          patch.petSlugs,
          options?.existingPetSlugs ?? null,
        )
      ) {
        return { ok: false, error: "collection_pet_limit" };
      }

      const value: ValidatedUpdateCollectionInput = { ...patch };

      if ("externalUrl" in raw && raw.externalUrl !== undefined) {
        const externalUrl = normalizeCollectionExternalUrl(raw.externalUrl);
        if (externalUrl === false) {
          return { ok: false, error: "external_url" };
        }
        value.externalUrl = externalUrl;
      }

      const hasCover = "coverPetSlug" in raw && raw.coverPetSlug !== undefined;
      let requestedCover: string | null | undefined;
      if (hasCover) {
        const normalizedCover = normalizeCollectionCover(raw.coverPetSlug);
        if (normalizedCover === false) {
          return { ok: false, error: "cover_pet_slug" };
        }
        requestedCover = normalizedCover;
      }

      if (patch.petSlugs !== undefined) {
        value.coverPetSlug = resolveCollectionCover(
          requestedCover,
          patch.petSlugs,
          options?.existingCoverPetSlug ?? null,
        );
      } else if (hasCover) {
        value.coverPetSlug = requestedCover ?? null;
      }

      if (raw.allApproved !== undefined) {
        value.allApproved = raw.allApproved as boolean;
      }

      return { ok: true, value };
    },

    buildSlug(title) {
      return collectionSlugBase(title);
    },

    isReservedSlug(slug) {
      const normalized = slugify(slug);
      return (
        normalized.length > 0 &&
        validateProfileHandle(normalized) === "reserved"
      );
    },

    sortListings(items, sort = "size") {
      return sortCollectionListingItems([...items], sort);
    },

    async getPublicBySlug(slug, limit) {
      const normalizedSlug = slug.trim().toLowerCase();
      if (!normalizedSlug) return null;
      const normalizedLimit = normalizeLimit(limit);
      const found = await store.getPublicBySlug(
        normalizedSlug,
        normalizedLimit,
      );
      if (!found) return null;
      return applyPetLimit(found, normalizedLimit);
    },

    async listPublicBySlugs(slugs, limit) {
      const normalizedSlugs: string[] = [];
      const seen = new Set<string>();
      for (const slug of slugs) {
        const normalized = slug.trim().toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        normalizedSlugs.push(normalized);
      }
      if (normalizedSlugs.length === 0) return [];

      const normalizedLimit = normalizeLimit(limit);
      const rows = await store.listPublicBySlugs(
        normalizedSlugs,
        normalizedLimit,
      );
      const bySlug = new Map(
        rows.map((row) => [
          row.slug.toLowerCase(),
          applyPetLimit(row, normalizedLimit),
        ]),
      );

      const ordered: PetCollectionWithPets[] = [];
      for (const slug of normalizedSlugs) {
        const match = bySlug.get(slug);
        if (match) ordered.push(match);
      }
      return ordered;
    },

    async listOwnerCollections(ownerId, petsPerPreview) {
      const normalizedOwnerId = ownerId.trim();
      if (!normalizedOwnerId) return [];
      const normalizedPreview =
        petsPerPreview === null ? null : normalizeLimit(petsPerPreview);
      const rows = await store.listOwnerCollections(
        normalizedOwnerId,
        normalizedPreview,
      );
      if (normalizedPreview === undefined || normalizedPreview === null) {
        return rows;
      }
      return rows.map((row) => ({
        ...applyPetLimit(row, normalizedPreview),
        petCount: row.petCount,
      }));
    },
  };
}

export const collectionsModule: CollectionsModule = createCollectionsModule();
