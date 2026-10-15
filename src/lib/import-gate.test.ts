import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

import { gateImportText } from "./import-gate";

const CLEAN = {
  displayName: "Boba",
  description: "A cozy cat for long coding sessions.",
};

describe("gateImportText", () => {
  test("passes clean fields", () => {
    expect(gateImportText(CLEAN)).toBeNull();
  });

  test("refuses a blocked keyword in the description", () => {
    const rejection = gateImportText({
      ...CLEAN,
      description: "A cozy pet inspired by Xiaomi gadgets",
    });
    expect(rejection?.kind).toBe("keyword");
    if (rejection?.kind === "keyword") {
      expect(rejection.keyword.toLowerCase()).toBe("xiaomi");
    }
  });

  test("refuses a blocked keyword in the credit name", () => {
    const rejection = gateImportText({
      ...CLEAN,
      creditName: "Xiaomi fan club",
    });
    expect(rejection?.kind).toBe("keyword");
  });

  test("refuses a Chinese phrase even inside longer text", () => {
    const rejection = gateImportText({
      ...CLEAN,
      description: "一只喜欢小米生态链的猫",
    });
    expect(rejection?.kind).toBe("keyword");
  });

  test("refuses a URL in the description", () => {
    const rejection = gateImportText({
      ...CLEAN,
      description: "follow me at https://evil.example/x",
    });
    expect(rejection?.kind).toBe("url");
    if (rejection?.kind === "url") expect(rejection.field).toBe("description");
  });

  test("refuses a URL-shaped credit url field value", () => {
    // creditUrl is expected to hold a URL on the import path; the gate's job
    // is the free-text fields. A description carrying one is the attack.
    const rejection = gateImportText({
      ...CLEAN,
      creditName: "see https://evil.example",
    });
    expect(rejection?.kind).toBe("url");
    if (rejection?.kind === "url") expect(rejection.field).toBe("creditName");
  });
});
