import { describe, expect, test } from "bun:test";

import {
  buildSetupSteps,
  parsePendingInstallSlugs,
  parsePendingPet,
} from "./setup-steps";

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

describe("parsePendingInstallSlugs", () => {
  test("returns all slugs for comma-separated install batch", () => {
    expect(parsePendingInstallSlugs("install/boba,doraemon,mochi")).toEqual([
      "boba",
      "doraemon",
      "mochi",
    ]);
  });

  test("rejects batch when any slug is invalid", () => {
    expect(parsePendingInstallSlugs("install/boba,NOTVALID")).toBeNull();
  });
});

describe("buildSetupSteps", () => {
  test("default flow is two steps: init + stay-updated", () => {
    // The setup flow collapsed to a single user action (`npx petdex
    // init`) plus the always-optional "stay updated" reminder.
    // Anything that drifts from those two keys is a regression worth
    // catching early.
    const steps = buildSetupSteps(makeT(), null);
    expect(steps.map((s) => s.key)).toEqual(["step1", "stayUpdated"]);
    expect(steps.find((s) => s.key === "installPet")).toBeUndefined();
  });

  test("step1 runs `npx petdex init` (the canonical first command)", () => {
    const steps = buildSetupSteps(makeT(), null);
    const init = steps.find((s) => s.key === "step1");
    expect(init).toBeDefined();
    if (!init) return;
    expect(init.command).toBe("npx petdex init");
    expect(init.title).toBe("T(setup.step1.title)");
    expect(init.hint).toBe("T(setup.step1.hint)");
  });

  test("install-pet step inserts after init when ?next=install/<slug>", () => {
    const steps = buildSetupSteps(makeT(), ["foxy"]);
    expect(steps.map((s) => s.key)).toEqual([
      "step1",
      "installPet",
      "stayUpdated",
    ]);
  });

  test("install-pet step uses the slug in the title and command", () => {
    const steps = buildSetupSteps(makeT(), ["foxy"]);
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

  test("install-pet step uses batch title and command for multiple slugs", () => {
    const steps = buildSetupSteps(makeT(), ["foxy", "boba"]);
    const installPet = steps.find((s) => s.key === "installPet");
    expect(installPet).toBeDefined();
    if (!installPet) return;
    expect(installPet.title).toBe("T(setup.installPets.title;count=2)");
    expect(installPet.command).toBe("npx petdex install foxy boba");
    expect(installPet.hint).toBe("T(setup.installPets.hint)");
  });

  test("only the stayUpdated step is dimmed (it's the optional reminder)", () => {
    const steps = buildSetupSteps(makeT(), ["foxy"]);
    const dimmed = steps.filter((s) => s.dimmed);
    expect(dimmed).toHaveLength(1);
    expect(dimmed[0]?.key).toBe("stayUpdated");
  });

  test("each step has a stable key for React reconciliation", () => {
    const steps = buildSetupSteps(makeT(), ["foxy"]);
    const keys = steps.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
