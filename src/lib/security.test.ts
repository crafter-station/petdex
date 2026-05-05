// Regression tests for the red-team round.
//
// Run: bun test --env-file=.env.local

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";

import {
  posixInstallScript,
  posixNotFoundScript,
  powershellInstallScript,
} from "@/lib/install-script-render";
import { validateSubmission } from "@/lib/submissions-validation";
import {
  isAllowedAssetUrl,
  isAllowedAvatarUrl,
  isSafeExternalUrl,
} from "@/lib/url-allowlist";

const BASE_INPUT = {
  zipUrl:
    "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/community/x/x.zip",
  spritesheetUrl:
    "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/community/x/spritesheet.webp",
  petJsonUrl:
    "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/community/x/pet.json",
  displayName: "Test Pet",
  description: "A test pet.",
  petId: "test-pet",
  spritesheetWidth: 1536,
  spritesheetHeight: 1872,
};

describe("isAllowedAssetUrl", () => {
  it("allows R2 https", () => {
    expect(
      isAllowedAssetUrl(
        "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/x/y.webp",
      ),
    ).toBe(true);
  });

  it("allows legacy uploadthing https", () => {
    expect(isAllowedAssetUrl("https://yu2vz9gndp.ufs.sh/f/abc")).toBe(true);
  });

  it("blocks http", () => {
    expect(
      isAllowedAssetUrl(
        "http://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/x/y.webp",
      ),
    ).toBe(false);
  });

  it("blocks javascript:", () => {
    expect(isAllowedAssetUrl("javascript:alert(1)")).toBe(false);
  });

  it("blocks data:", () => {
    expect(isAllowedAssetUrl("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    );
  });

  it("blocks attacker domain", () => {
    expect(isAllowedAssetUrl("https://evil.com/track.gif")).toBe(false);
  });

  it("blocks LAN / metadata IPs", () => {
    expect(isAllowedAssetUrl("https://169.254.169.254/latest/meta-data/")).toBe(
      false,
    );
    expect(isAllowedAssetUrl("https://localhost:3000/api/admin/secret")).toBe(
      false,
    );
  });

  it("rejects empty / undefined", () => {
    expect(isAllowedAssetUrl("")).toBe(false);
    expect(isAllowedAssetUrl(null)).toBe(false);
    expect(isAllowedAssetUrl(undefined)).toBe(false);
  });
});

describe("validateSubmission", () => {
  it("accepts a normal R2 submission", () => {
    expect(validateSubmission(BASE_INPUT)).toBeNull();
  });

  it("rejects javascript: in zipUrl", () => {
    const r = validateSubmission({
      ...BASE_INPUT,
      zipUrl: "javascript:alert(document.cookie)",
    });
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) {
      expect(r.error).toBe("invalid_asset_url");
      expect(r.field).toBe("zipUrl");
    }
  });

  it("rejects external host in spritesheetUrl", () => {
    const r = validateSubmission({
      ...BASE_INPUT,
      spritesheetUrl: "https://evil.com/track.gif",
    });
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) {
      expect(r.field).toBe("spritesheetUrl");
    }
  });

  it("rejects shell-injection in petJsonUrl (off allowlist)", () => {
    const r = validateSubmission({
      ...BASE_INPUT,
      petJsonUrl: "https://evil.example.com/x'; rm -rf $HOME; echo 'pwned",
    });
    expect(r?.ok).toBe(false);
    if (r && r.ok === false) {
      expect(r.field).toBe("petJsonUrl");
    }
  });
});

describe("posixInstallScript shell-injection", () => {
  const shAvailable = spawnSync("sh", ["-c", "exit 0"]).status === 0;

  const safeBase = {
    slug: "boba",
    displayName: "Boba",
    petJsonUrl:
      "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/curated/boba/pet.json",
    spritesheetUrl:
      "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/curated/boba/spritesheet.webp",
    spriteExt: "webp" as const,
  };

  it("escapes single quotes in URLs (sh syntax-checks clean)", () => {
    if (!shAvailable) return;

    // If our hard-quoting was wrong, the script wouldn't parse — `sh -n`
    // would surface a syntax error. We don't actually run it (would touch
    // the filesystem); we only prove the tokenization round-trips.
    const evilUrl = "https://x.com/a'; rm -rf /; echo '";
    const script = posixInstallScript({ ...safeBase, petJsonUrl: evilUrl });
    const r = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("strips path traversal from slug", () => {
    const script = posixInstallScript({ ...safeBase, slug: "../../etc/pas" });
    expect(script).not.toContain("..");
  });

  it("strips newlines from displayName", () => {
    const script = posixInstallScript({
      ...safeBase,
      displayName: "Boba\nrm -rf $HOME",
    });
    expect(script).not.toMatch(/\nrm -rf/);
  });

  it("notFound script also strips slug", () => {
    const out = posixNotFoundScript("../../etc/pas");
    expect(out).not.toContain("..");
  });
});

describe("powershellInstallScript", () => {
  it("doubles single quotes inside URLs", () => {
    const script = powershellInstallScript({
      slug: "boba",
      displayName: "Boba",
      petJsonUrl:
        "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/x/pet.json'; Remove-Item -Recurse $env:USERPROFILE; '",
      spritesheetUrl:
        "https://pub-94495283df974cfea5e98d6a9e3fa462.r2.dev/x/spritesheet.webp",
      spriteExt: "webp",
    });
    // Every ' inside the URL must be doubled, so PowerShell sees one
    // continuous string and never enters command-execution mode.
    expect(script).toContain("''");
    // The payload's quote-break "'; Remove-Item" should appear only
    // doubled (i.e. "''; Remove-Item" or further escaped), never as a
    // bare apostrophe followed by a command.
    expect(script).not.toMatch(/[^']'\s*;\s*Remove-Item/);
  });
});

describe("isSameOrigin (CSRF guard)", () => {
  const { isSameOrigin } =
    require("@/lib/same-origin") as typeof import("@/lib/same-origin");

  function reqWith(headers: Record<string, string>): Request {
    return new Request("https://petdex.crafter.run/api/x", {
      method: "POST",
      headers,
    });
  }

  it("allows same-origin browser POST", () => {
    expect(
      isSameOrigin(reqWith({ origin: "https://petdex.crafter.run" })),
    ).toBe(true);
  });

  it("allows localhost dev", () => {
    expect(isSameOrigin(reqWith({ origin: "http://localhost:3000" }))).toBe(
      true,
    );
  });

  it("blocks attacker.com cross-origin POST", () => {
    expect(isSameOrigin(reqWith({ origin: "https://evil.com" }))).toBe(false);
  });

  it("blocks origin null (e.g. data: pages)", () => {
    expect(isSameOrigin(reqWith({ origin: "null" }))).toBe(false);
  });

  it("uses Sec-Fetch-Site fallback when Origin missing", () => {
    expect(isSameOrigin(reqWith({ "sec-fetch-site": "same-origin" }))).toBe(
      true,
    );
    expect(isSameOrigin(reqWith({ "sec-fetch-site": "cross-site" }))).toBe(
      false,
    );
  });

  it("allows non-browser callers (no Origin, no Sec-Fetch)", () => {
    // curl, server-to-server fetch — they auth via bearer instead.
    expect(isSameOrigin(reqWith({ "user-agent": "curl/8.0" }))).toBe(true);
  });

  it("allows Vercel preview subdomain", () => {
    expect(
      isSameOrigin(reqWith({ origin: "https://petdex-abc123.vercel.app" })),
    ).toBe(true);
  });
});

describe("isAllowedAvatarUrl", () => {
  it("allows clerk and known socials", () => {
    expect(isAllowedAvatarUrl("https://img.clerk.com/eyJ...")).toBe(true);
    expect(
      isAllowedAvatarUrl("https://avatars.githubusercontent.com/u/12345?v=4"),
    ).toBe(true);
    expect(
      isAllowedAvatarUrl("https://storage.googleapis.com/avatars/x.png"),
    ).toBe(true);
  });
  it("rejects attacker-controlled host (tracking pixel)", () => {
    expect(isAllowedAvatarUrl("https://evil.com/track.gif")).toBe(false);
  });
  it("rejects javascript: / data:", () => {
    expect(isAllowedAvatarUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedAvatarUrl("data:image/png;base64,...")).toBe(false);
  });
});

describe("isSafeExternalUrl", () => {
  it("allows random https sites with hostnames", () => {
    expect(isSafeExternalUrl("https://github.com/x")).toBe(true);
    expect(isSafeExternalUrl("https://example.com/profile")).toBe(true);
  });
  it("rejects http", () => {
    expect(isSafeExternalUrl("http://github.com/x")).toBe(false);
  });
  it("rejects javascript: and data:", () => {
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("data:text/html,<script>")).toBe(false);
  });
  it("rejects bare IPs", () => {
    expect(isSafeExternalUrl("https://10.0.0.1/")).toBe(false);
    expect(isSafeExternalUrl("https://192.168.1.1/")).toBe(false);
  });
  it("rejects localhost", () => {
    expect(isSafeExternalUrl("https://localhost/foo")).toBe(false);
  });
});

describe("JsonLd escape", () => {
  it("escapes </script in user-controlled values", async () => {
    const { JsonLd } = await import("@/components/json-ld");
    // We render to a string-ish thing by inspecting the dangerouslySetInnerHTML
    // payload of the React element. The escaper is the unit under test.
    const evilName = "Boba</script><script>alert(1)</script>";
    const el = JsonLd({
      data: { name: evilName },
    }) as unknown as { props: { dangerouslySetInnerHTML: { __html: string } } };
    const html = el.props.dangerouslySetInnerHTML.__html;
    expect(html.toLowerCase()).not.toContain("</script>");
    expect(html).toContain("<\\/script");
  });

  it("escapes <!-- comment opener", async () => {
    const { JsonLd } = await import("@/components/json-ld");
    const el = JsonLd({
      data: { x: "before<!--after" },
    }) as unknown as { props: { dangerouslySetInnerHTML: { __html: string } } };
    expect(el.props.dangerouslySetInnerHTML.__html).not.toContain("<!--");
  });
});
