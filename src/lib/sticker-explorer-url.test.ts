import { describe, expect, it } from "bun:test";

import {
  parseStickerDeck,
  parseStickerExplorerSelection,
  STICKER_DECK_LIMIT,
  upsertStickerExplorerParams,
} from "@/lib/sticker-explorer-url";

const pets = ["claude-crab", "clawd"];

describe("sticker explorer URL", () => {
  it("parses an exact selection and falls back safely", () => {
    expect(
      parseStickerExplorerSelection(
        new URLSearchParams("reaction=review&pet=clawd&treatment=clean"),
        pets,
      ),
    ).toEqual({ pet: "clawd", state: "review", treatment: "clean" });
    expect(
      parseStickerExplorerSelection(
        new URLSearchParams("reaction=nope&pet=nope&treatment=nope"),
        pets,
      ),
    ).toEqual({
      pet: "claude-crab",
      state: "waiting",
      treatment: "outline",
    });
  });

  it("deduplicates, validates, and caps shared decks", () => {
    const value = Array.from(
      { length: STICKER_DECK_LIMIT + 4 },
      (_, index) =>
        `${index % 2 === 0 ? "claude-crab" : "clawd"}.${
          ["idle", "waiting", "review", "failed"][index % 4]
        }.${index % 3 === 0 ? "clean" : "outline"}`,
    ).join(",");
    const deck = parseStickerDeck(`${value},invalid.waiting.clean`, pets);
    expect(deck.length).toBeLessThanOrEqual(STICKER_DECK_LIMIT);
    expect(new Set(deck.map((item) => JSON.stringify(item))).size).toBe(
      deck.length,
    );
  });

  it("writes the canonical share URL contract", () => {
    const selection = {
      pet: "claude-crab",
      state: "waiting" as const,
      treatment: "outline" as const,
    };
    const params = upsertStickerExplorerParams(
      new URLSearchParams("ignored=1"),
      selection,
      [selection],
    );
    expect(params.get("reaction")).toBe("waiting");
    expect(params.get("pet")).toBe("claude-crab");
    expect(params.get("treatment")).toBe("outline");
    expect(params.get("deck")).toBe("claude-crab.waiting.outline");
  });
});
