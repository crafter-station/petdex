// Pet zips are served from a different origin (assets.petdex.dev), and
// browsers ignore the HTML `download` attribute for cross-origin URLs.
// A plain `<a href={zipUrl} download="boba.zip">` therefore still saves
// the file as `zip.zip` — the last segment of the R2 key. Fetching the
// zip into a blob first and saving it through an object URL is what
// actually keeps the pet slug as the filename.

const OBJECT_URL_REVOKE_DELAY_MS = 60_000;

export async function downloadPetZip(
  zipUrl: string,
  slug: string,
): Promise<void> {
  const filename = `${slug}.zip`;
  const objectUrl = await fetchZipObjectUrl(zipUrl);

  if (!objectUrl) {
    // The blob path fails when the request never leaves the browser
    // (privacy tools strip the Referer the assets host requires). Fall
    // back to the plain link so the download still happens.
    clickDownloadLink(zipUrl, filename);
    return;
  }

  clickDownloadLink(objectUrl, filename);
  // Revoking in the same tick aborts the save in some browsers.
  setTimeout(() => URL.revokeObjectURL(objectUrl), OBJECT_URL_REVOKE_DELAY_MS);
}

async function fetchZipObjectUrl(zipUrl: string): Promise<string | null> {
  try {
    const response = await fetch(zipUrl);
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
