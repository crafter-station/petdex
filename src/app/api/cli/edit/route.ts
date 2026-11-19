import { NextResponse } from "next/server";

import { verifyCliBearer } from "@/lib/cli-auth";
import { applyPetEdit, type PatchBody } from "@/lib/pet-edit";
import { publicTrafficGuardKey } from "@/lib/public-traffic-guard";
import { cliVerifyRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

export async function PATCH(req: Request): Promise<Response> {
  const verifyLim = await cliVerifyRatelimit.limit(
    publicTrafficGuardKey(req.headers),
  );
  if (!verifyLim.success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const principal = await verifyCliBearer(req.headers.get("authorization"));
  if (!principal) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: PatchBody & { petId?: string };
  try {
    body = (await req.json()) as PatchBody & { petId?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  // A literal `null` parses fine; the property reads below would 500 it.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const petId = typeof body.petId === "string" ? body.petId.trim() : "";
  if (!petId) {
    return NextResponse.json({ error: "missing_pet_id" }, { status: 400 });
  }

  const { petId: _petId, ...editBody } = body;
  return applyPetEdit({ id: petId, userId: principal.userId, body: editBody });
}
