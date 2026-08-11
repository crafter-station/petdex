export type SubmissionAssetRole = "zip" | "sprite" | "petjson";

export function buildSubmissionAssetKey(
  slugHint: string,
  uploadId: string,
  role: SubmissionAssetRole,
  extension: string,
): string {
  return `pets/${slugHint}-${uploadId}/${role}.${extension}`;
}
