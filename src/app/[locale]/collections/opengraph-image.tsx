// OG image for /collections (the index). Shows a stack of cover sprites
// from the first 6 featured collections so the share preview reads as
// "this page is a gallery of curated sets" rather than a generic title.

import { ImageResponse } from "next/og";

import sharp from "sharp";

import { getFeaturedCollections } from "@/lib/collections";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";

import { defaultLocale, hasLocale } from "@/i18n/config";

export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const alt = "Petdex featured collections";
// 24h ISR. Featured collections rotate slowly (curator picks them by
// hand). The unfurl bots that hit this path are by far the noisiest
// thing on the Vercel bill, and the rendered PNG is identical for
// hours at a time. See per-pet opengraph-image.tsx for the same
// reasoning.

const FRAME_W = 192;
const FRAME_H = 208;

export default async function Image({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const copy = await getOgImageCopy(locale);

  const collections = await getFeaturedCollections(6);
  const tiles = await Promise.all(
    collections.map(async (col) => {
      const lead =
        col.pets.find((p) => p.slug === col.coverPetSlug) ?? col.pets[0];
      if (!lead) return null;
      const dataUrl = await loadFirstFrameAsDataUrl(lead.spritesheetPath);
      return dataUrl
        ? { title: col.title, count: col.pets.length, dataUrl }
        : null;
    }),
  );
  const visibleTiles = tiles.filter((t): t is NonNullable<typeof t> =>
    Boolean(t),
  );

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background:
          "linear-gradient(120deg, #d8e9ff 0%, #f7f8ff 47%, #c9c6ff 100%)",
        position: "relative",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 50% 30%, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0.45) 28%, transparent 60%)",
          display: "flex",
        }}
      />

      {/* Top brand row */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "44px 56px 0 56px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            color: "#0a0a0a",
            fontSize: 28,
            fontWeight: 600,
          }}
        >
          <PetdexMark size={44} />
          <span>Petdex</span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            color: "#5266ea",
            fontSize: 18,
            letterSpacing: 4,
            textTransform: "uppercase",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontWeight: 600,
          }}
        >
          {copy.featuredCollectionsLabel}
        </div>
      </div>

      {/* Title */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          padding: "16px 56px 8px 56px",
          color: "#0a0a0a",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 76,
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: -2,
          }}
        >
          {copy.heroTitle}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 26,
            color: "#5b6076",
            marginTop: 12,
            maxWidth: 980,
          }}
        >
          {copy.heroSubtitle}
        </div>
      </div>

      {/* Tile grid: 3 cols × 2 rows */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 16,
          padding: "0 56px 36px 56px",
          flex: 1,
          alignContent: "flex-end",
        }}
      >
        {visibleTiles.slice(0, 6).map((tile) => (
          <div
            key={tile.title}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              width: 340,
              height: 156,
              borderRadius: 24,
              backgroundColor: "rgba(255,255,255,0.78)",
              border: "1px solid rgba(82,102,234,0.18)",
              padding: 16,
              gap: 10,
            }}
          >
            <div style={{ display: "flex", height: 90 }}>
              {/* biome-ignore lint/performance/noImgElement: og runtime needs <img> */}
              <img
                src={tile.dataUrl}
                width={Math.round(90 * (FRAME_W / FRAME_H))}
                height={90}
                alt=""
              />
            </div>
            <div
              style={{
                display: "flex",
                fontSize: 18,
                fontWeight: 600,
                color: "#0a0a0a",
              }}
            >
              {tile.title}
            </div>
          </div>
        ))}
      </div>
    </div>,
    { ...size },
  );
}

async function getOgImageCopy(locale: string) {
  const resolvedLocale = locale && hasLocale(locale) ? locale : defaultLocale;
  const messages = (await import(`@/i18n/messages/${resolvedLocale}.json`))
    .default as {
    ogImage?: {
      featuredCollectionsLabel?: string;
      heroTitle?: string;
      heroSubtitle?: string;
    };
  };
  return {
    featuredCollectionsLabel:
      messages.ogImage?.featuredCollectionsLabel ?? "Featured collections",
    heroTitle: messages.ogImage?.heroTitle ?? "Catch the whole set",
    heroSubtitle:
      messages.ogImage?.heroSubtitle ??
      "Curated character families for your Codex desk.",
  };
}

async function loadFirstFrameAsDataUrl(url: string): Promise<string | null> {
  if (!isAllowedAssetUrl(url)) return null;
  try {
    const res = await fetch(url, { redirect: "error" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const png = await sharp(buf)
      .extract({ left: 0, top: 0, width: FRAME_W, height: FRAME_H })
      .resize(FRAME_W * 2, FRAME_H * 2, { kernel: "nearest" })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return null;
  }
}

function PetdexMark({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: "flex" }}
    >
      <defs>
        <linearGradient id="og-petdex-body" x1="8" y1="8" x2="56" y2="56">
          <stop stopColor="#3847f5" />
          <stop offset="1" stopColor="#1a1d2e" />
        </linearGradient>
      </defs>
      <rect
        x="6"
        y="6"
        width="52"
        height="52"
        rx="14"
        fill="url(#og-petdex-body)"
      />
      <circle cx="24" cy="28" r="4" fill="#fff" />
      <circle cx="40" cy="28" r="4" fill="#fff" />
      <rect x="22" y="40" width="20" height="4" rx="2" fill="#fff" />
    </svg>
  );
}
