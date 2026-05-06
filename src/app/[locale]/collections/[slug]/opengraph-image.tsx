// Per-collection OG image rendered via next/og. Mirrors the per-pet OG
// (gradient bg, brand purple, mono caption) but lays the lead pet plus
// up to 4 squad members across the canvas to communicate "this is a
// curated set." Satori doesn't decode WebP, so we crop the first idle
// frame of every sprite with sharp and inject as PNG data URLs.

import { ImageResponse } from "next/og";

import sharp from "sharp";

import { getCollection } from "@/lib/collections";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";

import { defaultLocale, hasLocale } from "@/i18n/config";

export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const alt = "Petdex collection preview";
// 24h ISR for the same reason the per-pet OG caches: every Discord /
// Slack / X unfurl was re-running sharp + 6 sprite fetches before
// this. See per-pet opengraph-image.tsx.

const FRAME_W = 192;
const FRAME_H = 208;

export default async function Image({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const copy = await getOgImageCopy(locale);
  const collection = await getCollection(slug);

  if (!collection) {
    return petdexFallback();
  }

  // Lead pet is centered and rendered larger; squad members fan out
  // to either side. Cap at 5 total so the canvas isn't crowded.
  const leadPet =
    collection.pets.find((p) => p.slug === collection.coverPetSlug) ??
    collection.pets[0];
  const squad = collection.pets
    .filter((p) => p.slug !== leadPet?.slug)
    .slice(0, 4);

  const sprites = await Promise.all(
    [leadPet, ...squad]
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map(async (p) => ({
        slug: p.slug,
        name: p.displayName,
        dataUrl: await loadFirstFrameAsDataUrl(p.spritesheetPath),
      })),
  );
  const validSprites = sprites.filter((s) => s.dataUrl);
  const lead = validSprites[0] ?? null;
  const others = validSprites.slice(1);

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
            gap: 8,
            color: "#5266ea",
            fontSize: 18,
            letterSpacing: 4,
            textTransform: "uppercase",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontWeight: 600,
          }}
        >
          <span>{copy.collectionLabel}</span>
        </div>
      </div>

      {/* Squad strip */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
          gap: 12,
          padding: "0 56px",
          flex: 1,
          marginTop: 16,
        }}
      >
        {others.slice(0, 2).map((s) => (
          <Sprite key={s.slug} dataUrl={s.dataUrl ?? ""} size={170} />
        ))}
        {lead ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 320,
              height: 320,
              borderRadius: 36,
              backgroundColor: "rgba(255,255,255,0.82)",
              border: "1px solid rgba(82,102,234,0.18)",
              flexShrink: 0,
            }}
          >
            <Sprite dataUrl={lead.dataUrl ?? ""} size={260} />
          </div>
        ) : null}
        {others.slice(2, 4).map((s) => (
          <Sprite key={s.slug} dataUrl={s.dataUrl ?? ""} size={170} />
        ))}
      </div>

      {/* Title block */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          padding: "0 56px 32px 56px",
          color: "#0a0a0a",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 22,
            color: "#5266ea",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            letterSpacing: 4,
            textTransform: "uppercase",
            marginBottom: 10,
          }}
        >
          {collection.pets.length} {copy.petsLabel}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 78,
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: -2,
            color: "#0a0a0a",
            marginBottom: 16,
          }}
        >
          {collection.title}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 24,
            lineHeight: 1.35,
            color: "#202127",
            maxWidth: 1080,
          }}
        >
          {clip(collection.description, 160)}
        </div>
      </div>

      {/* Bottom URL */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 56px 36px 56px",
        }}
      >
        <div
          style={{
            display: "flex",
            color: "#5b6076",
            fontSize: 20,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            letterSpacing: 2,
            textTransform: "uppercase",
          }}
        >
          petdex.crafter.run/collections/{collection.slug}
        </div>
      </div>
    </div>,
    { ...size },
  );
}

function Sprite({ dataUrl, size }: { dataUrl: string; size: number }) {
  if (!dataUrl) return null;
  const display = size;
  const aspect = FRAME_W / FRAME_H;
  const w = Math.round(display * aspect);
  return (
    <div style={{ display: "flex", width: w, height: display }}>
      {/* biome-ignore lint/performance/noImgElement: og runtime needs <img> */}
      <img src={dataUrl} width={w} height={display} alt="" />
    </div>
  );
}

async function getOgImageCopy(locale: string) {
  const resolvedLocale = locale && hasLocale(locale) ? locale : defaultLocale;
  const messages = (await import(`@/i18n/messages/${resolvedLocale}.json`))
    .default as {
    ogImage?: { collectionLabel?: string; petsLabel?: string };
  };
  return {
    collectionLabel: messages.ogImage?.collectionLabel ?? "Featured collection",
    petsLabel: messages.ogImage?.petsLabel ?? "pets",
  };
}

async function loadFirstFrameAsDataUrl(url: string): Promise<string | null> {
  if (!isAllowedAssetUrl(url)) {
    console.warn("[og-collection] blocked off-allowlist sprite url");
    return null;
  }
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
  } catch (err) {
    console.warn(
      "[og-collection] sprite decode failed:",
      (err as Error).message,
    );
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

function petdexFallback() {
  return new ImageResponse(
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100%",
        background:
          "linear-gradient(120deg, #d8e9ff 0%, #f7f8ff 47%, #c9c6ff 100%)",
        alignItems: "center",
        justifyContent: "center",
        color: "#0a0a0a",
        fontSize: 80,
        fontWeight: 700,
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      Petdex
    </div>,
    { ...size },
  );
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1).trimEnd()}…`;
}
