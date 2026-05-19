import type { ReviewCheckDecision } from "@/lib/submission-review-types";

export type PetSecurityFinding = {
  code: string;
  severity: "fail" | "hold";
  path: string;
  evidence: string;
};

export type PetSecurityScan = {
  decision: ReviewCheckDecision;
  reasons: string[];
  findings: PetSecurityFinding[];
};

type ScanInput = {
  petJson: unknown;
  displayName?: string | null;
  description?: string | null;
};

const MAX_FINDINGS = 24;
const MAX_DEPTH = 12;
const MAX_NODES = 3000;
const MAX_ARRAY_ITEMS = 120;
const MAX_STRING_LENGTH = 4000;

const executableKey =
  /^(command|cmd|exec|shell|script|scripts|postinstall|preinstall|installcommand|hook|hooks|launchagent|plist)$/i;
const sensitiveKey =
  /^(apikey|api_key|authtoken|auth_token|secret|token|env|envfile|env_file)$/i;

const failPatterns: Array<{ code: string; re: RegExp }> = [
  {
    code: "shell_command_substitution",
    re: /\$\([^)\r\n]{1,500}\)|`[^`\r\n]{1,500}`/,
  },
  {
    code: "shell_download_pipe",
    re: /\b(?:curl|wget)\b[\s\S]{0,240}\|\s*(?:sh|bash|zsh|fish)\b/i,
  },
  {
    code: "powershell_download_execute",
    re: /\b(?:irm|iwr|invoke-webrequest)\b[\s\S]{0,240}\|\s*(?:iex|invoke-expression)\b/i,
  },
  {
    code: "interpreter_inline_execution",
    re: /\b(?:sh|bash|zsh|fish|cmd\.exe|powershell|pwsh|osascript|python3?|node|ruby|perl)\s+-(?:c|e|enc|encodedcommand)\b/i,
  },
  {
    code: "destructive_shell_command",
    re: /\b(?:rm\s+-rf|chmod\s+\+x|chown\s+|launchctl\s+(?:load|bootstrap)|crontab\s+-|nc\s+-e|mkfifo\s+)\b/i,
  },
  {
    code: "credential_exfiltration_reference",
    re: /(?:~\/\.ssh|\/\.ssh\/|id_rsa|id_ed25519|\.env\b|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|CLERK_SECRET_KEY|process\.env|document\.cookie|localStorage)/i,
  },
  {
    code: "active_script_url",
    re: /\b(?:javascript|vbscript|file):/i,
  },
  {
    code: "html_data_url",
    re: /\bdata\s*:\s*(?:text\/html|application\/javascript|text\/javascript)/i,
  },
];

const holdPatterns: Array<{ code: string; re: RegExp }> = [
  {
    code: "external_url_in_pet_json",
    re: /\bhttps?:\/\/[^\s"'<>]+/i,
  },
  {
    code: "encoded_payload_marker",
    re: /\b(?:base64|fromcharcode|atob|eval|new Function)\b/i,
  },
];

export function scanPetSecurity(input: ScanInput): PetSecurityScan {
  const findings: PetSecurityFinding[] = [];
  let nodes = 0;

  const add = (
    severity: PetSecurityFinding["severity"],
    code: string,
    path: string,
    evidence: string,
  ) => {
    if (findings.length >= MAX_FINDINGS) return;
    const clipped = evidence.replace(/\s+/g, " ").trim().slice(0, 220);
    if (
      findings.some(
        (finding) =>
          finding.code === code &&
          finding.path === path &&
          finding.evidence === clipped,
      )
    ) {
      return;
    }
    findings.push({ severity, code, path, evidence: clipped });
  };

  const scanText = (path: string, value: string, key?: string) => {
    if (value.length > MAX_STRING_LENGTH) {
      add("hold", "large_string_value", path, `String length ${value.length}`);
    }
    if (hasBlockedControlCharacter(value)) {
      add("fail", "control_character_payload", path, value);
    }

    for (const pattern of failPatterns) {
      if (pattern.re.test(value)) add("fail", pattern.code, path, value);
    }
    for (const pattern of holdPatterns) {
      if (pattern.re.test(value)) add("hold", pattern.code, path, value);
    }

    if (key && executableKey.test(key) && value.trim()) {
      add("fail", "executable_metadata_key", path, `${key}: ${value}`);
    }
    if (key && sensitiveKey.test(key) && value.trim()) {
      add("hold", "sensitive_metadata_key", path, `${key}: ${value}`);
    }
    if (key && /path$/i.test(key)) {
      if (/^\s*(?:\/|~\/|[a-z]:\\|\\\\|https?:\/\/)/i.test(value)) {
        add("hold", "absolute_or_remote_path", path, `${key}: ${value}`);
      }
      if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) {
        add("fail", "path_traversal", path, `${key}: ${value}`);
      }
    }
  };

  const scan = (value: unknown, path: string, depth: number, key?: string) => {
    nodes += 1;
    if (nodes > MAX_NODES) {
      add("hold", "json_too_large_to_scan", path, `Visited ${nodes} nodes`);
      return;
    }
    if (depth > MAX_DEPTH) {
      add("hold", "json_too_deep", path, `Depth ${depth}`);
      return;
    }

    if (typeof value === "string") {
      scanText(path, value, key);
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) {
        add("hold", "large_array_value", path, `Array length ${value.length}`);
      }
      value.slice(0, MAX_ARRAY_ITEMS).forEach((item, index) => {
        scan(item, `${path}[${index}]`, depth + 1);
      });
      return;
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const [childKey, childValue] of Object.entries(record)) {
        if (executableKey.test(childKey) && typeof childValue !== "string") {
          add(
            "hold",
            "executable_metadata_key",
            joinPath(path, childKey),
            childKey,
          );
        }
        if (sensitiveKey.test(childKey) && typeof childValue !== "string") {
          add(
            "hold",
            "sensitive_metadata_key",
            joinPath(path, childKey),
            childKey,
          );
        }
        scan(childValue, joinPath(path, childKey), depth + 1, childKey);
      }
    }
  };

  if (!isPlainRecord(input.petJson)) {
    add("hold", "pet_json_root_not_object", "$", typeof input.petJson);
  } else {
    scan(input.petJson, "$", 0);
  }

  if (input.displayName) scanText("submitted.displayName", input.displayName);
  if (input.description) scanText("submitted.description", input.description);

  const hasFail = findings.some((finding) => finding.severity === "fail");
  const hasHold = findings.some((finding) => finding.severity === "hold");
  const decision: ReviewCheckDecision = hasFail
    ? "fail"
    : hasHold
      ? "hold"
      : "pass";

  return {
    decision,
    reasons: findings.map((finding) => `${finding.code}: ${finding.evidence}`),
    findings,
  };
}

function joinPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasBlockedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0 || code === 27 || code === 127) return true;
  }
  return false;
}
