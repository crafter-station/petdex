const OBJECT_URL_REVOKE_DELAY_MS = 60_000;

export async function downloadPetZip(
  zipUrl: string,
  slug: string,
): Promise<void> {
  const filename = `${slug}.zip`;
  const objectUrl = await fetchZipObjectUrl(zipUrl);

  if (!objectUrl) {
    clickDownloadLink(zipUrl, filename);
    return;
  }

  clickDownloadLink(objectUrl, filename);
  setTimeout(() => URL.revokeObjectURL(objectUrl), OBJECT_URL_REVOKE_DELAY_MS);
}

async function fetchZipObjectUrl(zipUrl: string): Promise<string | null> {
  try {
    const response = await fetch(zipUrl, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return null;
    return URL.createObjectURL(await response.blob());
  } catch {
    return null;
  }
}

function clickDownloadLink(href: string, filename: string): void {
  const link = document.createElement("a");
  link.href = href;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
