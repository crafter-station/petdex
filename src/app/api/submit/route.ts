import { NextResponse } from "next/server";

import { auth, currentUser } from "@clerk/nextjs/server";

import { submitRatelimit } from "@/lib/ratelimit";
import {
  REQUIRED_SPRITESHEET_DIMS,
  registerSubmittedPet,
} from "@/lib/submissions";

export const runtime = "nodejs";

type SubmitBody = {
  zipUrl: string;
  spritesheetUrl: string;
  petJsonUrl: string;
  displayName: string;
  description: string;
  petId: string;
  spritesheetWidth: number;
  spritesheetHeight: number;
};

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const limit = await submitRatelimit.limit(userId);
  if (!limit.success) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "Limit reached: 3 submissions / 24h. Try again tomorrow.",
        retryAfter: limit.reset,
      },
      { status: 429 },
    );
  }

  let body: SubmitBody;
  try {
    body = (await req.json()) as SubmitBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const requiredFields = [
    "zipUrl",
    "spritesheetUrl",
    "petJsonUrl",
    "displayName",
    "description",
    "petId",
    "spritesheetWidth",
    "spritesheetHeight",
  ] as const;

  for (const field of requiredFields) {
    if (!body[field]) {
      return NextResponse.json(
        { error: "missing_field", field },
        { status: 400 },
      );
    }
  }

  if (
    body.spritesheetWidth !== REQUIRED_SPRITESHEET_DIMS.width ||
    body.spritesheetHeight !== REQUIRED_SPRITESHEET_DIMS.height
  ) {
    return NextResponse.json(
      {
        error: "invalid_spritesheet",
        message: `Spritesheet must be ${REQUIRED_SPRITESHEET_DIMS.width}x${REQUIRED_SPRITESHEET_DIMS.height}.`,
        got: { width: body.spritesheetWidth, height: body.spritesheetHeight },
      },
      { status: 400 },
    );
  }

  const user = await currentUser();
  const ownerEmail =
    user?.emailAddresses?.[0]?.emailAddress ??
    user?.primaryEmailAddress?.emailAddress ??
    null;

  const result = await registerSubmittedPet({
    zipUrl: body.zipUrl,
    spritesheetUrl: body.spritesheetUrl,
    petJsonUrl: body.petJsonUrl,
    displayName: body.displayName.trim().slice(0, 60),
    description: body.description.trim().slice(0, 280),
    petId: body.petId,
    spritesheetWidth: body.spritesheetWidth,
    spritesheetHeight: body.spritesheetHeight,
    ownerId: userId,
    ownerEmail,
    kind: "creature",
  });

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json(result.body, { status: 201 });
}
