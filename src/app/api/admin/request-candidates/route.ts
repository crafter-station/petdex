import { NextResponse } from "next/server";

import { auth, clerkClient } from "@clerk/nextjs/server";
import { Resend } from "resend";

import { isAdmin } from "@/lib/admin";
import { renderRequestFulfilledCreatorEmail } from "@/lib/email-templates/request-fulfilled-creator";
import { renderRequestFulfilledRequesterEmail } from "@/lib/email-templates/request-fulfilled-requester";
import { createNotification } from "@/lib/notifications";
import { approveCandidate, rejectCandidate } from "@/lib/request-candidates";
import { requireSameOrigin } from "@/lib/same-origin";
import { getPreferredLocaleForUser } from "@/lib/user-locale";

export const runtime = "nodejs";

async function emailUser(
  userId: string,
  rendered: { subject: string; html: string; text: string },
): Promise<void> {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const client = await clerkClient();
    const u = await client.users.getUser(userId);
    const email = u.primaryEmailAddress?.emailAddress;
    if (!email) return;
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from =
      process.env.RESEND_FROM ?? "Petdex <petdex@updates.railly.dev>";
    await resend.emails.send({
      from,
      to: email,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
  } catch (e) {
    console.warn("[request-candidates] email failed:", e);
  }
}

type Body = {
  action: "approve" | "reject";
  petId: string;
  requestId: string;
  reason?: string;
};

export async function POST(req: Request): Promise<Response> {
  const csrf = requireSameOrigin(req);
  if (csrf) return csrf;

  const { userId } = await auth();
  if (!isAdmin(userId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (
    !body.petId ||
    !body.requestId ||
    (body.action !== "approve" && body.action !== "reject")
  ) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  if (body.action === "reject") {
    const result = await rejectCandidate({
      petId: body.petId,
      requestId: body.requestId,
      // biome-ignore lint/style/noNonNullAssertion: isAdmin gate above
      resolvedBy: userId!,
      reason: body.reason,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.reason },
        { status: result.reason === "not_found" ? 404 : 409 },
      );
    }
    return NextResponse.json({ ok: true });
  }

  const result = await approveCandidate({
    petId: body.petId,
    requestId: body.requestId,
    // biome-ignore lint/style/noNonNullAssertion: isAdmin gate above
    resolvedBy: userId!,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.reason },
      { status: result.reason === "not_found" ? 404 : 409 },
    );
  }

  // Fire notifications and emails: requester (their request is fulfilled)
  // and creator (their pet earned a fulfill credit). Both use the
  // existing request_fulfilled kind; payload distinguishes via `role`.
  // Best-effort — failures are logged and swallowed.
  if (result.requesterId) {
    void createNotification({
      userId: result.requesterId,
      kind: "request_fulfilled",
      payload: {
        role: "requester",
        requestQuery: result.requestQuery,
        petSlug: result.petSlug,
        petName: result.petDisplayName,
      },
      href: `/pets/${result.petSlug}`,
    }).catch(() => {});

    void (async () => {
      // biome-ignore lint/style/noNonNullAssertion: requesterId checked above
      const locale = await getPreferredLocaleForUser(result.requesterId!);
      const rendered = renderRequestFulfilledRequesterEmail(locale, {
        petName: result.petDisplayName,
        petSlug: result.petSlug,
        requestQuery: result.requestQuery,
      });
      // biome-ignore lint/style/noNonNullAssertion: requesterId checked above
      await emailUser(result.requesterId!, rendered);
    })();
  }

  void createNotification({
    userId: result.petOwnerId,
    kind: "request_fulfilled",
    payload: {
      role: "creator",
      requestQuery: result.requestQuery,
      petSlug: result.petSlug,
      petName: result.petDisplayName,
    },
    href: `/pets/${result.petSlug}`,
  }).catch(() => {});

  void (async () => {
    const locale = await getPreferredLocaleForUser(result.petOwnerId);
    const rendered = renderRequestFulfilledCreatorEmail(locale, {
      petName: result.petDisplayName,
      petSlug: result.petSlug,
      requestQuery: result.requestQuery,
    });
    await emailUser(result.petOwnerId, rendered);
  })();

  return NextResponse.json({ ok: true });
}
