// The resend webhook is public and unauthenticated by definition — the svix
// signature is verified against the raw body, so the body must be read before
// the caller is trusted. It used to `req.text()` whatever arrived, letting an
// anonymous POST pick the process's buffer size. These tests pin the ceiling,
// the signature paths around it, and the forward-only status machine: Resend
// retries and delivers out of order, and an `email.sent` landing after
// `email.opened` used to walk the row backwards.
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { createHmac } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as schema from "@/lib/db/schema";

const client = new PGlite();
const testDb = drizzle(client, { schema });

mock.module("@/lib/db/client", () => ({
  db: testDb,
  schema,
  // Named because mock.module is process-wide and first-registration-wins:
  // src/lib/db-client-mock-shape.test.ts asserts every factory provides them.
  executeAtomicReturning: async () => [],
  rowsOf: () => [],
}));

const { POST } = await import("@/app/api/webhooks/resend/route");

// A structurally valid svix secret, so `new Webhook(secret)` succeeds and the
// tests below exercise real verification rather than the constructor throw.
const SECRET = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;
const MSG_ID = "msg_1";
const originalSecret = process.env.RESEND_WEBHOOK_SECRET;

// svix signs `${id}.${timestamp}.${payload}` with the base64-decoded secret
// and prefixes the version — the same scheme `wh.verify` checks below. The
// timestamp must be near-now: verify enforces a five-minute tolerance
// (standardwebhooks WEBHOOK_TOLERANCE_IN_SECONDS), so a fixed one 400s.
function svixHeaders(payload: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
  const digest = createHmac("sha256", key)
    .update(`${MSG_ID}.${timestamp}.${payload}`)
    .digest("base64");
  return {
    "svix-id": MSG_ID,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${digest}`,
  };
}

beforeAll(async () => {
  await testDb.execute(sql`
    CREATE TABLE IF NOT EXISTS "email_sends" (
      "id" text PRIMARY KEY,
      "user_id" text NOT NULL,
      "email" text NOT NULL,
      "campaign" text NOT NULL,
      "batch_key" text NOT NULL,
      "resend_id" text,
      "status" text NOT NULL DEFAULT 'queued',
      "error" text,
      "sent_at" timestamp with time zone,
      "delivered_at" timestamp with time zone,
      "opened_at" timestamp with time zone,
      "bounced_at" timestamp with time zone,
      "complained_at" timestamp with time zone,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
});

afterAll(async () => {
  if (originalSecret === undefined) delete process.env.RESEND_WEBHOOK_SECRET;
  else process.env.RESEND_WEBHOOK_SECRET = originalSecret;
  await client.close();
});

function post(
  body: BodyInit,
  headers: Record<string, string> = {},
): Promise<Response> {
  return POST(
    new Request("https://petdex.dev/api/webhooks/resend", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

async function seedEmail(status = "queued"): Promise<void> {
  await testDb.execute(sql`DELETE FROM "email_sends"`);
  await testDb.execute(
    sql`INSERT INTO "email_sends" ("id", "user_id", "email", "campaign", "batch_key", "resend_id", "status")
        VALUES ('e1', 'user_1', 'a@b.c', 'desktop_launch', 'batch_1', 'resend_1', ${status})`,
  );
}

async function row(): Promise<{
  status: string;
  openedAt: string | null;
  sentAt: string | null;
}> {
  const result = (await testDb.execute(
    sql`SELECT "status", "opened_at" AS "openedAt", "sent_at" AS "sentAt" FROM "email_sends" WHERE "resend_id" = 'resend_1'`,
  )) as unknown as {
    rows?: Array<{
      status: string;
      openedAt: string | null;
      sentAt: string | null;
    }>;
  };
  const rows = (result.rows ?? (result as unknown as never[])) as Array<{
    status: string;
    openedAt: string | null;
    sentAt: string | null;
  }>;
  return rows[0] as {
    status: string;
    openedAt: string | null;
    sentAt: string | null;
  };
}

function deliver(
  type: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const payload = JSON.stringify({
    type,
    created_at: "2026-05-09T00:00:00.000Z",
    data: { email_id: "resend_1", ...extra },
  });
  return post(payload, svixHeaders(payload));
}

describe("POST /api/webhooks/resend", () => {
  it("fails closed when the webhook secret is not configured", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const res = await post("{}", {
      "svix-id": MSG_ID,
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,abc",
    });
    expect(res.status).toBe(500);
  });

  it("refuses an oversized body with 413", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    // A concrete body sets content-length, so the route can refuse from the
    // declared size alone — no buffering, no signature work.
    const res = await post(new Uint8Array(300 * 1024), {
      "svix-id": MSG_ID,
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,abc",
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toBe(
      "payload_too_large",
    );
  });

  it("still rejects a signed-but-wrong small body with 400", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    const res = await post('{"type":"email.sent"}', {
      "svix-id": MSG_ID,
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,AAAA",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "signature_invalid",
    );
  });

  it("requires the svix headers before anything else", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    const res = await post("{}");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "signature_missing",
    );
  });

  it("advances a queued row to opened", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    await seedEmail("queued");
    expect((await deliver("email.opened")).status).toBe(200);
    expect((await row()).status).toBe("opened");
    expect((await row()).openedAt).not.toBeNull();
  });

  it("does not walk the status backwards on an out-of-order event", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    await seedEmail("opened");
    // Resend can deliver email.sent after email.opened; the row must stay
    // opened and the late event must not stamp sentAt.
    expect((await deliver("email.sent")).status).toBe(200);
    expect((await row()).status).toBe("opened");
    expect((await row()).sentAt).toBeNull();
  });

  it("treats a repeated event as a no-op rather than an error", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    await seedEmail("delivered");
    expect((await deliver("email.delivered")).status).toBe(200);
    expect((await row()).status).toBe("delivered");
  });

  // Covers every non-terminal status rather than just `opened`: the CASE that
  // ranks the stored status and STATUS_RANK are one ordering now, and this
  // pins that a terminal event still reaches each of them.
  it("lets a terminal event advance every non-terminal stored status", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    for (const status of ["queued", "sent", "delivered", "opened"]) {
      await seedEmail(status);
      expect((await deliver("email.bounced")).status).toBe(200);
      expect((await row()).status).toBe("bounced");
    }
  });

  it("ignores an unknown event type", async () => {
    process.env.RESEND_WEBHOOK_SECRET = SECRET;
    await seedEmail("sent");
    expect((await deliver("email.something_new")).status).toBe(200);
    expect((await row()).status).toBe("sent");
  });
});
