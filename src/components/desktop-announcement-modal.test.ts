import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./desktop-announcement-modal.tsx", import.meta.url),
  "utf8",
);

describe("DesktopAnnouncementModal theme classes", () => {
  it("does not hardcode a light modal surface while using theme text", () => {
    expect(source).not.toContain("border-border-base bg-white");
  });

  it("uses the desktop icon asset, not the removed vibe-search image", () => {
    expect(source).toContain("petdex-desktop-icon.png");
    expect(source).not.toContain("vibe-search");
  });

  it("announces through the desktop announcement message namespace", () => {
    expect(source).toContain('useTranslations("desktopAnnouncement")');
    expect(source).toContain('t("title")');
    expect(source).toContain('t("downloadCta")');
  });
});
