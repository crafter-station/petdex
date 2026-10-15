import { describe, expect, test } from "bun:test";

import { renderNewSubmissionEmail } from "@/lib/email-templates/new-submission";
import { sanitizeSubject } from "@/lib/email-templates/shared";
import { renderSubmissionApprovedEmail } from "@/lib/email-templates/submission-approved";
import { renderSubmissionTakedownEmail } from "@/lib/email-templates/submission-takedown";

// User-controlled names (pet displayName, request queries) are interpolated
// into email subjects. A CR/LF in a subject is the classic SMTP header
// injection vector, and the defense in `submissions.ts` was bypassable: it
// used `subject.replace(displayName, safeName)`, and a replacement string
// expands `$&`, so a name containing `$&` re-inserted the matched CRLF.
// `sanitizeSubject` now runs at the point of interpolation in every template
// that puts user data in the subject.

describe("sanitizeSubject", () => {
  test("strips CR, LF, TAB and other control characters", () => {
    expect(sanitizeSubject("A\r\nB\tC\u0000D\u007fE")).toBe("A B C D E");
  });

  test("is immune to the $& replacement-expansion bypass", () => {
    // The old defense produced `...A\r\nX-Evil: 1$&` from this input.
    const result = sanitizeSubject("A\r\nX-Evil: 1$&");
    expect(result).not.toMatch(/[\r\n\t]/);
    expect(result).toContain("X-Evil");
  });

  test("leaves ordinary text untouched", () => {
    expect(sanitizeSubject("Boba the Otter")).toBe("Boba the Otter");
  });
});

describe("email subjects are header-safe by construction", () => {
  const evil = "Boba\r\nBcc: victim@example.com";

  test("new-submission", () => {
    const email = renderNewSubmissionEmail("en", {
      displayName: evil,
      slug: "boba",
      from: "someone@example.com",
      description: "desc",
      spritesheetUrl: "https://assets.petdex.dev/x.webp",
      zipUrl: "https://assets.petdex.dev/x.zip",
    });
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  test("submission-approved", () => {
    const email = renderSubmissionApprovedEmail("en", {
      petName: evil,
      petSlug: "boba",
    });
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  test("submission-takedown", () => {
    const email = renderSubmissionTakedownEmail("en", {
      petName: evil,
      reason: null,
    });
    expect(email.subject).not.toMatch(/[\r\n]/);
  });
});
