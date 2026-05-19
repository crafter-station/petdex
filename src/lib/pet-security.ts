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

type ManifestScanInput = ScanInput & {
  zipPetJson?: unknown;
};

const MAX_FINDINGS = 24;
const MAX_DEPTH = 12;
const MAX_NODES = 3000;
const MAX_ARRAY_ITEMS = 120;
const MAX_STRING_LENGTH = 4000;
const CAPPED_FAIL_EVIDENCE =
  "[redacted security finding omitted by evidence cap]";

const executableKey =
  /^(command|cmd|exec|shell|script|scripts|postinstall|preinstall|installcommand|hook|hooks|launchagent|plist)$/i;
const exactSensitiveKey =
  /^(apikey|api_key|authtoken|auth_token|secret|token|env|envfile|env_file)$/i;
const normalizedSensitiveKey =
  /(?:apikey|authtoken|accesstoken|refreshtoken|secret|token|envfile|privatekey)$/i;
const providerSecretKey =
  /^(?:openai|anthropic|github|clerk|vercel|stripe|supabase|neon).*(?:key|token|secret)$/i;
const freeTextKey =
  /^(displayname|display_name|name|title|description|summary|bio|notes?|author)$/i;
const credentialReferenceRe =
  /(?:~\/\.ssh|\/\.ssh\/|id_rsa|id_ed25519|\.env\b|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|CLERK_SECRET_KEY|process\.env|document\.cookie|localStorage)/i;
const tokenValueRe =
  /\b(?:sk-(?:proj|live|test|ant|admin)-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:pk|sk)_(?:live|test)_[A-Za-z0-9]{8,}|rk_(?:live|test)_[A-Za-z0-9]{8,}|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b/g;

const failPatterns: Array<{ code: string; re: RegExp }> = [
  {
    code: "shell_command_substitution",
    re: /\$\([^)\r\n]{1,500}\)|`(?=[^`\r\n]{0,500}\b(?:curl|wget|rm|chmod|chown|bash|sh|zsh|fish|cmd\.exe|powershell|pwsh|osascript|python3?|node|ruby|perl|touch|nc|mkfifo|launchctl|crontab)\b)[^`\r\n]{1,500}`/i,
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
    code: "active_script_url",
    re: /\b(?:javascript|vbscript):[^\s"'<>]+|\bfile:\/\/[^\s"'<>]+/i,
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
  let hasFail = false;
  let hasHold = false;
  let nodes = 0;

  const add = (
    severity: PetSecurityFinding["severity"],
    code: string,
    path: string,
    evidence: string,
    key?: string,
  ) => {
    if (severity === "fail") hasFail = true;
    if (severity === "hold") hasHold = true;
    const clipped = redactEvidence(code, evidence, key)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 220);
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
    if (findings.length >= MAX_FINDINGS) {
      if (
        severity === "fail" &&
        !findings.some((finding) => finding.severity === "fail")
      ) {
        findings[MAX_FINDINGS - 1] = {
          severity,
          code,
          path,
          evidence: CAPPED_FAIL_EVIDENCE,
        };
      }
      return;
    }
    findings.push({ severity, code, path, evidence: clipped });
  };

  const scanText = (path: string, value: string, key?: string) => {
    if (value.length > MAX_STRING_LENGTH) {
      add(
        "hold",
        "large_string_value",
        path,
        `String length ${value.length}`,
        key,
      );
    }
    if (hasBlockedControlCharacter(value)) {
      add("fail", "control_character_payload", path, value, key);
    }

    for (const pattern of failPatterns) {
      if (pattern.re.test(value)) add("fail", pattern.code, path, value, key);
    }
    if (credentialReferenceRe.test(value)) {
      add(
        isFreeTextField(path, key) ? "hold" : "fail",
        "credential_exfiltration_reference",
        path,
        value,
        key,
      );
    }
    if (hasTokenValue(value)) {
      add(
        key && isSensitiveKey(key) ? "fail" : "hold",
        "secret_token_value",
        path,
        value,
        key,
      );
    }
    for (const pattern of holdPatterns) {
      if (pattern.re.test(value)) add("hold", pattern.code, path, value, key);
    }

    if (key && executableKey.test(key) && value.trim()) {
      add("fail", "executable_metadata_key", path, `${key}: ${value}`, key);
    }
    if (key && isSensitiveKey(key) && value.trim()) {
      add("hold", "sensitive_metadata_key", path, `${key}: ${value}`, key);
    }
    if (key && /path$/i.test(key)) {
      if (/^\s*(?:\/|~\/|[a-z]:\\|\\\\|https?:\/\/)/i.test(value)) {
        add("hold", "absolute_or_remote_path", path, `${key}: ${value}`, key);
      }
      if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) {
        add("fail", "path_traversal", path, `${key}: ${value}`, key);
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
        scanText(joinPath(path, childKey), childKey);
        if (executableKey.test(childKey) && typeof childValue !== "string") {
          add(
            "hold",
            "executable_metadata_key",
            joinPath(path, childKey),
            childKey,
          );
        }
        if (isSensitiveKey(childKey) && typeof childValue !== "string") {
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

export function scanPetManifestsSecurity(
  input: ManifestScanInput,
): PetSecurityScan {
  const petJsonScan = scanPetSecurity({ petJson: input.petJson });
  const submittedScan = scanPetSecurity({
    petJson: {},
    displayName: input.displayName,
    description: input.description,
  });
  const decisions = [petJsonScan.decision, submittedScan.decision];
  const findings = [
    ...prefixFindings(petJsonScan.findings, "petJsonUrl"),
    ...prefixFindings(submittedScan.findings, "submitted"),
  ];

  if (input.zipPetJson !== undefined) {
    const zipScan = scanPetSecurity({ petJson: input.zipPetJson });
    decisions.push(zipScan.decision);
    findings.push(...prefixFindings(zipScan.findings, "zip.petJson"));
    const petJsonStable = stableJson(input.petJson);
    const zipPetJsonStable = stableJson(input.zipPetJson);
    if (!petJsonStable || !zipPetJsonStable) {
      findings.push({
        code: "pet_json_manifest_comparison_limit",
        severity: "hold",
        path: "zip.petJson",
        evidence: "manifest comparison exceeded safety limits",
      });
    } else if (petJsonStable !== zipPetJsonStable) {
      findings.push({
        code: "pet_json_manifest_mismatch",
        severity: "hold",
        path: "zip.petJson",
        evidence: "zip pet.json differs from standalone petJsonUrl",
      });
    }
  }

  return scanFromFindings(findings, decisions);
}

function scanFromFindings(
  findings: PetSecurityFinding[],
  decisions: ReviewCheckDecision[] = [],
): PetSecurityScan {
  const hasFail =
    decisions.includes("fail") ||
    findings.some((finding) => finding.severity === "fail");
  const hasHold =
    decisions.includes("hold") ||
    findings.some((finding) => finding.severity === "hold");
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

export function petSecurityReason(
  scan: PetSecurityScan,
  preferredSeverity?: PetSecurityFinding["severity"],
): string | null {
  const finding = preferredSeverity
    ? scan.findings.find((finding) => finding.severity === preferredSeverity)
    : scan.findings[0];
  if (finding) return `${finding.code}: ${finding.evidence}`;
  return scan.reasons[0] ?? null;
}

export function petSecurityPathSegment(value: string): string {
  return isUnsafePathSegment(value) ? "redactedKey" : value;
}

function prefixFindings(
  findings: PetSecurityFinding[],
  prefix: string,
): PetSecurityFinding[] {
  return findings.map((finding) => ({
    ...finding,
    path:
      finding.path === "$"
        ? prefix
        : `${prefix}${finding.path.startsWith("$") ? finding.path.slice(1) : `.${finding.path}`}`,
  }));
}

function joinPath(parent: string, key: string): string {
  const segment = petSecurityPathSegment(key);
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)
    ? `${parent}.${segment}`
    : `${parent}[${JSON.stringify(segment)}]`;
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

function isFreeTextField(path: string, key?: string): boolean {
  return (
    path === "submitted.displayName" ||
    path === "submitted.description" ||
    (key !== undefined && freeTextKey.test(key))
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "");
  return (
    exactSensitiveKey.test(key) ||
    normalizedSensitiveKey.test(normalized) ||
    providerSecretKey.test(normalized)
  );
}

function isUnsafePathSegment(value: string): boolean {
  if (hasTokenValue(value)) return true;
  if (credentialReferenceRe.test(value)) return true;
  if (hasBlockedControlCharacter(value)) return true;
  return failPatterns.some((pattern) => pattern.re.test(value));
}

function hasTokenValue(value: string): boolean {
  tokenValueRe.lastIndex = 0;
  return tokenValueRe.test(value);
}

function redactEvidence(code: string, evidence: string, key?: string): string {
  if (key && isSensitiveKey(key)) {
    return `${petSecurityPathSegment(key)}: [redacted]`;
  }
  if (
    code === "credential_exfiltration_reference" ||
    credentialReferenceRe.test(evidence)
  ) {
    return "[redacted credential reference]";
  }
  if (code === "sensitive_metadata_key") {
    const key = evidence.split(":")[0]?.trim();
    return key
      ? `${petSecurityPathSegment(key)}: [redacted]`
      : "[redacted sensitive value]";
  }
  tokenValueRe.lastIndex = 0;
  return evidence.replace(tokenValueRe, "[redacted secret]");
}

function stableJson(value: unknown): string | null {
  let nodes = 0;

  const visit = (node: unknown, depth: number): string | null => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) return null;
    if (typeof node === "string" && node.length > MAX_STRING_LENGTH) {
      return null;
    }
    if (Array.isArray(node)) {
      if (node.length > MAX_ARRAY_ITEMS) return null;
      const items = [];
      for (const item of node) {
        const value = visit(item, depth + 1);
        if (value === null) return null;
        items.push(value);
      }
      return `[${items.join(",")}]`;
    }
    if (isPlainRecord(node)) {
      const keys = Object.keys(node).sort();
      if (keys.length > MAX_ARRAY_ITEMS) return null;
      const entries = [];
      for (const key of keys) {
        const value = visit(node[key], depth + 1);
        if (value === null) return null;
        entries.push(`${JSON.stringify(key)}:${value}`);
      }
      return `{${entries.join(",")}}`;
    }
    return JSON.stringify(node);
  };

  return visit(value, 0);
}
