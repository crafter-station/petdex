import { createHash, randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { Resend } from "resend";

import { db, schema } from "@/lib/db/client";
import { getPet } from "@/lib/pets";
import type { PetKind } from "@/lib/types";

export const REQUIRED_SPRITESHEET_DIMS = {
  width: 1536,
  height: 1872,
} as const;

type RegisterSubmissionInput = {
  zipUrl: string;
  spritesheetUrl: string;
  petJsonUrl: string;
  displayName: string;
  description: string;
  petId: string;
  spritesheetWidth: number;
  spritesheetHeight: number;
  ownerId: string;
  ownerEmail: string | null;
  kind?: PetKind;
};

export async function registerSubmittedPet(input: RegisterSubmissionInput) {
  if (
    input.spritesheetWidth !== REQUIRED_SPRITESHEET_DIMS.width ||
    input.spritesheetHeight !== REQUIRED_SPRITESHEET_DIMS.height
  ) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error: "invalid_spritesheet",
        message: `Spritesheet must be ${REQUIRED_SPRITESHEET_DIMS.width}x${REQUIRED_SPRITESHEET_DIMS.height}.`,
        got: {
          width: input.spritesheetWidth,
          height: input.spritesheetHeight,
        },
      },
    };
  }

  const requestedSlug = slugify(input.petId || input.displayName);
  if (!requestedSlug) {
    return {
      ok: false as const,
      status: 400,
      body: { error: "invalid_slug" },
    };
  }

  const slug = await resolveUniqueSlug(requestedSlug);
  const id = `pet_${randomUUID().replace(/-/g, "").slice(0, 22)}`;

  await db.insert(schema.submittedPets).values({
    id,
    slug,
    displayName: input.displayName.trim().slice(0, 60),
    description: input.description.trim().slice(0, 280),
    spritesheetUrl: input.spritesheetUrl,
    petJsonUrl: input.petJsonUrl,
    zipUrl: input.zipUrl,
    kind: input.kind ?? "creature",
    vibes: [],
    tags: [],
    status: "pending",
    ownerId: input.ownerId,
    ownerEmail: input.ownerEmail,
  });

  await notifyOwner({
    displayName: input.displayName,
    description: input.description,
    ownerEmail: input.ownerEmail,
    ownerId: input.ownerId,
    slug,
    spritesheetUrl: input.spritesheetUrl,
    zipUrl: input.zipUrl,
  });

  return {
    ok: true as const,
    body: { ok: true, id, slug },
  };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function stableCliOwnerId(token: string) {
  return `cli_${createHash("sha256").update(token).digest("hex").slice(0, 24)}`;
}

async function resolveUniqueSlug(base: string): Promise<string> {
  const isTaken = async (candidate: string): Promise<boolean> => {
    if (getPet(candidate)) return true;
    const row = await db.query.submittedPets.findFirst({
      where: eq(schema.submittedPets.slug, candidate),
    });
    return Boolean(row);
  };

  if (!(await isTaken(base))) return base;

  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`.slice(0, 40);
    if (!(await isTaken(candidate))) return candidate;
  }

  return `${base.slice(0, 32)}-${randomUUID().slice(0, 6)}`;
}

async function notifyOwner({
  displayName,
  description,
  ownerEmail,
  ownerId,
  slug,
  spritesheetUrl,
  zipUrl,
}: {
  displayName: string;
  description: string;
  ownerEmail: string | null;
  ownerId: string;
  slug: string;
  spritesheetUrl: string;
  zipUrl: string;
}) {
  const resendKey = process.env.RESEND_API_KEY;
  const ownerNotify = process.env.PETDEX_OWNER_EMAIL;
  if (!resendKey || !ownerNotify) return;

  try {
    const resend = new Resend(resendKey);
    await resend.emails.send({
      from: "Petdex <petdex@notifications.crafter.run>",
      to: ownerNotify,
      subject: `New pet submission: ${displayName}`,
      text: [
        `Pet: ${displayName} (${slug})`,
        `From: ${ownerEmail ?? ownerId}`,
        "",
        description,
        "",
        `Sprite: ${spritesheetUrl}`,
        `Zip:    ${zipUrl}`,
      ].join("\n"),
    });
  } catch {
    /* silent */
  }
}
