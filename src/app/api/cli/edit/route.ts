import { NextResponse } from "next/server";

import { verifyCliBearer } from "@/lib/cli-auth";
import { applyPetEdit, type PatchBody } from "@/lib/pet-edit";
import { cliVerifyRatelimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return xff.split(",")[0]?.trim() || "anon";
}

export async function PATCH(req: Request): Promise<Response> {
  const verifyLim = await cliVerifyRatelimit.limit(clientIp(req));
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

  const petId = typeof body.petId === "string" ? body.petId.trim() : "";
  if (!petId) {
    return NextResponse.json({ error: "missing_pet_id" }, { status: 400 });
  }

  const { petId: _petId, ...editBody } = body;
  return applyPetEdit({ id: petId, userId: principal.userId, body: editBody });
}
