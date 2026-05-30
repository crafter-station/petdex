type BuildVersionTokenInput = {
  builtAt?: string | null;
  version: string;
};

export function createBuildVersionToken({
  builtAt,
  version,
}: BuildVersionTokenInput): string | null {
  const trimmedVersion = version.trim();
  if (!trimmedVersion) {
    return null;
  }

  const trimmedBuiltAt = builtAt?.trim();

  return trimmedBuiltAt
    ? `${trimmedVersion}|${trimmedBuiltAt}`
    : trimmedVersion;
}
