import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The submit flow uploads three R2 objects and then registers them through
// `/api/submit`. The upload stage was always inside a try/catch, but the
// register call was not: a dropped connection, an edge 502, or a non-JSON
// response rejected outside any handler, so the component stayed on
// `{kind:"uploading", step:"registering"}` — the button spun on "Finalizing…"
// forever, with no error card and no retry, while the uploaded objects were
// never registered. This guard pins the two failure paths so a future edit
// cannot unwrap them again.
const source = readFileSync(
  new URL("./pet-submit-form.tsx", import.meta.url),
  "utf8",
);

/** The register stage: from the "registering" state to the success state. */
function registerStage(): string {
  const start = source.indexOf('step: "registering"');
  expect(start, "register stage marker missing").toBeGreaterThan(-1);
  const end = source.indexOf('kind: "success"', start);
  expect(end, "success state missing after register stage").toBeGreaterThan(-1);
  return source.slice(start, end);
}

describe("submit form register-stage failure handling", () => {
  test("the register fetch is wrapped in try/catch that surfaces an error", () => {
    const stage = registerStage();
    const fetchAt = stage.indexOf('await fetch("/api/submit"');
    expect(fetchAt, "register fetch missing").toBeGreaterThan(-1);

    // The fetch sits inside a try block...
    const tryBefore = stage.lastIndexOf("try {", fetchAt);
    expect(
      tryBefore,
      "register fetch is not inside a try block",
    ).toBeGreaterThan(-1);
    const catchAfter = stage.indexOf("} catch", fetchAt);
    expect(catchAfter, "register fetch has no catch").toBeGreaterThan(fetchAt);

    // ...and that catch routes to the error state with a user-facing message.
    const catchBody = stage.slice(
      catchAfter,
      stage.indexOf("}", catchAfter + 8),
    );
    expect(catchBody).toContain('kind: "error"');
    expect(catchBody).toContain("errors.");
  });

  test("the success response parse has its own fallback", () => {
    const stage = registerStage();
    // Two error-producing paths after the ok-check: the non-2xx branch and the
    // JSON parse of the 2xx body. Both must set the error state.
    const errorSites = stage.match(/kind: "error"/g) ?? [];
    expect(errorSites.length).toBeGreaterThanOrEqual(3);
  });
});

describe("submit form prefills within the stored window", () => {
  // A pet.json description longer than the server stores used to prefill the
  // form in full (`maxLength` blocks new keystrokes, not a prefilled value),
  // and the server's `trim().slice(0, 280)` then silently kept the first 280,
  // so the author saw text they had not actually submitted. The prefill now
  // slices to the same constants the server uses.
  test("the pet.json prefill slices display name and description", () => {
    const at = source.indexOf("petJson.displayName.trim()");
    expect(at, "prefill block missing").toBeGreaterThan(-1);
    const block = source.slice(at, at + 700);
    expect(block).toContain("MAX_DISPLAY_NAME_LENGTH");
    expect(block).toContain("MAX_DESCRIPTION_LENGTH");
    expect(block).toContain(".slice(0, MAX_DISPLAY_NAME_LENGTH)");
    expect(block).toContain(".slice(0, MAX_DESCRIPTION_LENGTH)");
  });
});
