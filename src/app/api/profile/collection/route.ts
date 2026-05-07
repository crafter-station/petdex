import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";

import { canManageCreatorCollections } from "@/lib/collection-access";
import { db, schema } from "@/lib/db/client";
import { validateProfileHandle } from "@/lib/profiles";
import { requireSameOrigin } from "@/lib/same-origin";

const MAX_PETS = 24;
const MAX_TITLE = 80;
const MAX_DESCRIPTION = 280;

type PatchBody = {
  title?: string;
  description?: string;
  externalUrl?: string | null;
  coverPetSlug?: string | null;
  petSlugs?: string[];
};

export async function PATCH(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(await canManageCreatorCollections(userId))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: PatchBody;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const title = (body.title ?? "").trim();
  if (title.length < 2 || title.length > MAX_TITLE) {
    return NextResponse.json({ error: "title_length" }, { status: 400 });
  }

  const description = (body.description ?? "").trim();
  if (description.length > MAX_DESCRIPTION) {
    return NextResponse.json({ error: "description_length" }, { status: 400 });
  }

  const externalUrl = normalizeExternalUrl(body.externalUrl);
  if (externalUrl === false) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }

  const approvedPets = await db
    .select({ slug: schema.submittedPets.slug })
    .from(schema.submittedPets)
    .where(
      and(
        eq(schema.submittedPets.ownerId, userId),
        eq(schema.submittedPets.status, "approved"),
      ),
    );
  const allowedSlugs = new Set(approvedPets.map((pet) => pet.slug));
  const petSlugs = unique(body.petSlugs ?? [])
    .filter((slug) => allowedSlugs.has(slug))
    .slice(0, MAX_PETS);
  const coverPetSlug =
    body.coverPetSlug && petSlugs.includes(body.coverPetSlug)
      ? body.coverPetSlug
      : (petSlugs[0] ?? null);

  let [collection] = await db
    .select()
    .from(schema.petCollections)
    .where(eq(schema.petCollections.ownerId, userId))
    .limit(1);

  if (!collection) {
    const profile = await db.query.userProfiles.findFirst({
      where: eq(schema.userProfiles.userId, userId),
    });
    const slug = await collectionSlugForOwner(profile?.handle ?? title, userId);
    const id = `col_${crypto.randomUUID().replace(/-/g, "").slice(0, 18)}`;
    await db.insert(schema.petCollections).values({
      id,
      slug,
      title,
      description,
      ownerId: userId,
      externalUrl,
      coverPetSlug,
      featured: false,
    });
    collection = {
      id,
      slug,
      title,
      description,
      ownerId: userId,
      externalUrl,
      coverPetSlug,
      featured: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  } else {
    await db
      .update(schema.petCollections)
      .set({
        title,
        description,
        externalUrl,
        coverPetSlug,
        updatedAt: new Date(),
      })
      .where(eq(schema.petCollections.id, collection.id));
  }

  await db
    .delete(schema.petCollectionItems)
    .where(eq(schema.petCollectionItems.collectionId, collection.id));

  if (petSlugs.length > 0) {
    await db.insert(schema.petCollectionItems).values(
      petSlugs.map((petSlug, index) => ({
        collectionId: collection.id,
        petSlug,
        position: index + 1,
      })),
    );
  }

  revalidateTag("collections", "max");
  revalidateTag(`collection:${collection.slug}`, "max");
  revalidateTag(`profile:${userId}`, "max");

  return NextResponse.json({
    ok: true,
    collection: {
      id: collection.id,
      slug: collection.slug,
      title,
      description,
      externalUrl,
      coverPetSlug,
      petSlugs,
    },
  });
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const slug = value.trim().toLowerCase();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

function normalizeExternalUrl(
  value: string | null | undefined,
): string | null | false {
  const raw = (value ?? "").trim();
  if (!raw) return null;
  if (raw.length > 300) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    return url.toString();
  } catch {
    return false;
  }
}

async function collectionSlugForOwner(
  seed: string,
  userId: string,
): Promise<string> {
  let base = slugify(seed);
  if (!base || validateProfileHandle(base) === "reserved") {
    base = `collection-${userId.slice(-8).toLowerCase()}`;
  }
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await db.query.petCollections.findFirst({
      where: eq(schema.petCollections.slug, candidate),
    });
    if (!existing || existing.ownerId === userId) return candidate;
  }
  return `collection-${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
