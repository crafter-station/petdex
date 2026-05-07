import { createHash, randomBytes } from "node:crypto";

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

export function generateCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
  return base64Url(createHash("sha256").update(verifier).digest());
}

export function generateState(): string {
  return base64Url(randomBytes(32));
}
