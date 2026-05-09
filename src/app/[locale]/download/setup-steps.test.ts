import { describe, expect, test } from "bun:test";

import { buildSetupSteps, parsePendingPet } from "./setup-steps";

// A minimal stand-in for next-intl's translator. We only care about
// what KEY was looked up and that {slug} interpolation works, not
// about the actual localized strings.
function makeT() {
  return (key: string, values?: Record<string, string>) => {
    if (!values) return `T(${key})`;
    const pairs = Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    return `T(${key};${pairs})`;
  };
}

describe("parsePendingPet", () => {
  test("returns the slug when next is install/<slug>", () => {
    expect(parsePendingPet("install/foxy")).toBe("foxy");
    expect(parsePendingPet("install/anubis-cat-9")).toBe("anubis-cat-9");
  });

  test("rejects values without the install/ prefix", () => {
    expect(parsePendingPet("foxy")).toBeNull();
    expect(parsePendingPet("/install/foxy")).toBeNull();
    expect(parsePendingPet("update/foxy")).toBeNull();
  });

  test("rejects slugs that don't match the server regex", () => {
    expect(parsePendingPet("install/")).toBeNull();
    expect(parsePendingPet("install/-leading-dash")).toBeNull();
    expect(parsePendingPet("install/UPPER")).toBeNull();
    expect(parsePendingPet("install/has spaces")).toBeNull();
    expect(parsePendingPet("install/with/slash")).toBeNull();
    expect(parsePendingPet(`install/${"a".repeat(64)}`)).toBeNull();
  });

  test("accepts the boundary cases of the server regex", () => {
    // 1-char slug, alphanumeric start
    expect(parsePendingPet("install/a")).toBe("a");
    expect(parsePendingPet("install/0")).toBe("0");
    // 63 chars (1 + 62) is the max allowed
    const max = `a${"-".repeat(62)}`;
    expect(parsePendingPet(`install/${max}`)).toBe(max);
  });

  test("returns null for missing or empty inputs", () => {
    expect(parsePendingPet(undefined)).toBeNull();
    expect(parsePendingPet("")).toBeNull();
  });

  test("uses the first entry when next is repeated", () => {
    expect(parsePendingPet(["install/foxy", "install/dragon"])).toBe("foxy");
  });

  test("rejects when only the first entry is malformed (defensive)", () => {
    expect(parsePendingPet(["update/foxy", "install/dragon"])).toBeNull();
  });
});

describe("buildSetupSteps", () => {
  test("returns 4 steps when no pet is pending", () => {
    const steps = buildSetupSteps(makeT(), null);
    expect(steps.map((s) => s.key)).toEqual([
      "step1",
      "step2",
      "step3",
      "step4",
    ]);
    // The CTA promise of /pets/<slug> -> /download is only broken when
    // the install-pet step is missing AND a slug was promised. Without
    // a slug we expect the original 4-step flow unchanged.
    expect(steps.find((s) => s.key === "installPet")).toBeUndefined();
  });

  test("inserts the install-pet step between binary install and hooks install", () => {
    const steps = buildSetupSteps(makeT(), "foxy");
    expect(steps.map((s) => s.key)).toEqual([
      "step1",
      "installPet",
      "step2",
      "step3",
      "step4",
    ]);
  });

  test("install-pet step uses the slug in the title and command", () => {
    const steps = buildSetupSteps(makeT(), "foxy");
    const installPet = steps.find((s) => s.key === "installPet");
    expect(installPet).toBeDefined();
    if (!installPet) return;
    // Title goes through the translator with {slug} interpolation.
    expect(installPet.title).toBe("T(setup.installPet.title;slug=foxy)");
    // Command is verbatim — no template, no quoting needed because
    // parsePendingPet already constrains the slug to a-z0-9-.
    expect(installPet.command).toBe("npx petdex install foxy");
    expect(installPet.hint).toBe("T(setup.installPet.hint)");
  });

  test("only the last step is dimmed (it's the optional 'stay updated' step)", () => {
    const steps = buildSetupSteps(makeT(), "foxy");
    const dimmed = steps.filter((s) => s.dimmed);
    expect(dimmed).toHaveLength(1);
    expect(dimmed[0]?.key).toBe("step4");
  });

  test("each step has a stable key for React reconciliation", () => {
    const steps = buildSetupSteps(makeT(), "foxy");
    const keys = steps.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
