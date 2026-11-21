import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  CODING_AGENT_SLUGS,
  CODING_AGENTS,
  DEFAULT_INSTALL_COMMAND,
  getCodingAgent,
} from "@/lib/coding-agents";

import { locales } from "@/i18n/config";

const PUBLIC_DIR = path.resolve(import.meta.dir, "../../public");

describe("coding-agents", () => {
  test("defines all 10 canonical coding agents with unique slugs", () => {
    const slugs = CODING_AGENTS.map((agent) => agent.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toEqual([...CODING_AGENT_SLUGS]);
  });

  test("getCodingAgent resolves known slugs and returns undefined for unknown ones", () => {
    for (const agent of CODING_AGENTS) {
      expect(getCodingAgent(agent.slug)).toBe(agent);
    }
    expect(getCodingAgent("unknown-agent")).toBeUndefined();
  });

  test("every agent has complete localized en, es, and zh copy without em dashes", () => {
    for (const agent of CODING_AGENTS) {
      expect(agent.installCommand).toBe(DEFAULT_INSTALL_COMMAND);
      expect(agent.hookMechanism.trim().length).toBeGreaterThan(0);
      expect(agent.hookMechanism).not.toContain("\u2014");

      for (const locale of locales) {
        const localized = agent.copy[locale];
        expect(localized.title.trim().length).toBeGreaterThan(0);
        expect(localized.subtitle.trim().length).toBeGreaterThan(0);
        expect(localized.howItWorks.trim().length).toBeGreaterThan(0);
        expect(localized.faqs.length).toBeGreaterThanOrEqual(2);

        expect(localized.title).not.toContain("\u2014");
        expect(localized.subtitle).not.toContain("\u2014");
        expect(localized.howItWorks).not.toContain("\u2014");

        for (const faq of localized.faqs) {
          expect(faq.q.trim().length).toBeGreaterThan(0);
          expect(faq.a.trim().length).toBeGreaterThan(0);
          expect(faq.q).not.toContain("\u2014");
          expect(faq.a).not.toContain("\u2014");
        }
      }
    }
  });

  test("every declared agent icon exists under public/", () => {
    for (const agent of CODING_AGENTS) {
      expect(agent.icon.startsWith("/")).toBe(true);
      const assetPath = path.join(PUBLIC_DIR, agent.icon);
      expect(existsSync(assetPath)).toBe(true);
    }
  });
});
