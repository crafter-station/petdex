import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { emailEnv, sendEmail } from "./email-send";

// Resend's SDK does NOT reject on HTTP 4xx/5xx — it resolves with
// `{ data: null, error }`. Every caller used to write
// `try { await resend.emails.send(…) } catch { /* silent */ }`, so a rejected
// From domain or an exhausted quota dropped the mail with no log at all. These
// tests pin both halves: the helper surfaces the resolved error, and no app
// sender goes back to calling `emails.send` directly.

type Sent = { error?: unknown } | { data: unknown };

function fakeResend(result: Sent | (() => Promise<Sent>)) {
  return {
    emails: {
      send: async () =>
        typeof result === "function" ? await result() : result,
    },
  } as never;
}

const PAYLOAD = {
  from: "Petdex <petdex@updates.railly.dev>",
  to: "user@example.com",
  subject: "hi",
  html: "<p>hi</p>",
  text: "hi",
};

describe("sendEmail", () => {
  let logged: unknown[][];
  let errorSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    errorSpy?.mockRestore();
  });

  function capture() {
    logged = [];
    errorSpy = spyOn(console, "error").mockImplementation((...args) => {
      logged.push(args);
    });
  }

  it("logs a resolved error that the old try/catch never saw", async () => {
    capture();
    await sendEmail(
      fakeResend({ error: { name: "validation_error", message: "bad from" } }),
      PAYLOAD,
      "test notice",
    );
    expect(logged).toHaveLength(1);
    expect(String(logged[0][0])).toContain("test notice");
    expect(String(logged[0][0])).toContain("rejected");
  });

  it("logs a thrown send instead of swallowing it", async () => {
    capture();
    await sendEmail(
      fakeResend(() => Promise.reject(new Error("socket hang up"))),
      PAYLOAD,
      "test notice",
    );
    expect(logged).toHaveLength(1);
    expect(logged[0].map(String).join(" ")).toContain("socket hang up");
  });

  it("stays quiet on success", async () => {
    capture();
    const ok = await sendEmail(
      fakeResend({ data: { id: "abc" } }),
      PAYLOAD,
      "test",
    );
    expect(logged).toHaveLength(0);
    expect(ok).toBe(true);
  });

  it("reports false on a rejected or thrown send", async () => {
    capture();
    const rejected = await sendEmail(
      fakeResend({ error: { name: "validation_error", message: "bad from" } }),
      PAYLOAD,
      "test notice",
    );
    const thrown = await sendEmail(
      fakeResend(() => Promise.reject(new Error("socket hang up"))),
      PAYLOAD,
      "test notice",
    );
    expect(rejected).toBe(false);
    expect(thrown).toBe(false);
  });
});

describe("emailEnv treats a blank value as unset", () => {
  // `.env.example` ships `RESEND_FROM=` and `PETDEX_ADMIN_NOTIFY_EMAIL=` blank.
  // `??` kept `""`, so a copied example produced `from: ""` — which Resend
  // rejects on every send.
  const REAL_ENV = process.env.RESEND_FROM;

  afterEach(() => {
    if (REAL_ENV === undefined) delete process.env.RESEND_FROM;
    else process.env.RESEND_FROM = REAL_ENV;
  });

  it("falls back when the variable is unset", () => {
    delete process.env.RESEND_FROM;
    expect(emailEnv("RESEND_FROM", "Fallback <f@x.dev>")).toBe(
      "Fallback <f@x.dev>",
    );
  });

  it("falls back when the variable is blank, not just unset", () => {
    for (const blank of ["", "   "]) {
      process.env.RESEND_FROM = blank;
      expect(emailEnv("RESEND_FROM", "Fallback <f@x.dev>")).toBe(
        "Fallback <f@x.dev>",
      );
    }
  });

  it("keeps a configured value exactly as written", () => {
    process.env.RESEND_FROM = "Petdex <petdex@updates.railly.dev>";
    expect(emailEnv("RESEND_FROM", "Fallback <f@x.dev>")).toBe(
      "Petdex <petdex@updates.railly.dev>",
    );
  });
});

describe("app senders go through sendEmail", () => {
  // The four request-path senders. A direct `resend.emails.send(` in any of
  // them reintroduces the silent-drop bug this helper exists to close.
  const SENDERS = ["submissions.ts", "submission-decisions.ts", "takedown.ts"];
  const REPLIES = join(
    import.meta.dir,
    "..",
    "app",
    "api",
    "feedback",
    "[id]",
    "replies",
    "route.ts",
  );

  it("no lib sender calls emails.send directly", () => {
    for (const file of SENDERS) {
      const source = readFileSync(join(import.meta.dir, file), "utf8");
      expect(source, file).not.toContain("emails.send(");
      expect(source, file).toContain("sendEmail(");
    }
  });

  it("the feedback replies route calls emails.send only via sendEmail", () => {
    const source = readFileSync(REPLIES, "utf8");
    expect(source).not.toContain("emails.send(");
    expect(source).toContain("sendEmail(");
  });

  // The one-off operator scripts that mail an affected creator: same Resend
  // contract, same silent drop when they call `emails.send` bare.
  const SCRIPT_SENDERS = [
    "takedown-pet.ts",
    "takedown-by-keyword.ts",
    "revive-rejected-pets.ts",
  ];

  it("the operator scripts send through sendEmail too", () => {
    for (const file of SCRIPT_SENDERS) {
      const source = readFileSync(
        join(import.meta.dir, "..", "..", "scripts", file),
        "utf8",
      );
      expect(source, file).not.toContain("emails.send(");
      expect(source, file).toContain("sendEmail(");
    }
  });
});
