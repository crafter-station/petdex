// Per-pet OG image rendered via next/og. Same brand language as the site:
// petdex-cloud gradient bg, brand purple #5266ea + accent #3847f5, mono caption.
//
// Satori (the next/og engine) doesn't decode WebP. We fetch the spritesheet,
// crop the first 256×256 state with sharp, and inject it as a PNG data URL.

import { ImageResponse } from "next/og";

import sharp from "sharp";

import { getPet } from "@/lib/pets";
import { isAllowedAssetUrl } from "@/lib/url-allowlist";

import { defaultLocale, hasLocale } from "@/i18n/config";

export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const alt = "Petdex pet preview";
// Cache the rendered PNG aggressively. Pet sprites change rarely — when
// a pet is taken down or its sprite swapped, it gets a new slug suffix,
// so the OG path changes. Old slugs go 404. Without this, every Discord
// / Slack / X unfurl re-runs sharp + the spritesheet fetch, which is
// the single biggest line on the Vercel bill (Fluid CPU + Origin
// Transfer combined). 24h ISR + immutable headers neutralize it.

// Petdex spritesheets are an 8-column × 9-row grid (max frames per state ×
// state count). Per-frame size is 192×208 — most states use fewer than 8
// frames; the unused tail of each row is transparent padding.
// See src/lib/pet-states.ts.
const FRAME_W = 192;
const FRAME_H = 208;
// Upscaled display inside the 380-wide plate. Keep aspect ratio so the
// pet doesn't squish.
const DISPLAY_H = 340;
const DISPLAY_W = Math.round(DISPLAY_H * (FRAME_W / FRAME_H));

export default async function Image({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const copy = await getOgImageCopy(locale);
  const pet = await getPet(slug);

  if (!pet) {
    return petdexFallback();
  }

  const spriteDataUrl = await loadFirstFrameAsDataUrl(pet.spritesheetPath);

  const tagsLine =
    pet.tags
      .slice(0, 4)
      .map((t) => `#${t}`)
      .join("  ") || `#${pet.kind}`;
  const vibesLine = pet.vibes.slice(0, 3).join(" · ") || pet.kind;

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
      {/* Soft white center cloud */}
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
          {pet.featured ? <StarMark size={18} /> : null}
          <span>{pet.featured ? copy.featuredPet : copy.codexPet}</span>
        </div>
      </div>

      {/* Main row: sprite + text */}
      <div
        style={{
          display: "flex",
          flex: 1,
          padding: "16px 64px 32px 64px",
          alignItems: "center",
          gap: 56,
        }}
      >
        {/* Sprite plate. The inner wrapper is sized to exactly DISPLAY_W ×
            DISPLAY_H so Satori has no leftover space to tile the image into. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 380,
            height: 380,
            borderRadius: 36,
            backgroundColor: "rgba(255,255,255,0.82)",
            border: "1px solid rgba(82,102,234,0.18)",
            flexShrink: 0,
          }}
        >
          {spriteDataUrl ? (
            <div
              style={{
                display: "flex",
                width: DISPLAY_W,
                height: DISPLAY_H,
              }}
            >
              {/* biome-ignore lint/performance/noImgElement: og runtime needs <img> */}
              <img
                src={spriteDataUrl}
                width={DISPLAY_W}
                height={DISPLAY_H}
                alt=""
              />
            </div>
          ) : null}
        </div>

        {/* Text column */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            color: "#0a0a0a",
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 24,
              color: "#5266ea",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              letterSpacing: 4,
              textTransform: "uppercase",
              marginBottom: 14,
            }}
          >
            {vibesLine}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 92,
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: -2,
              color: "#0a0a0a",
              marginBottom: 20,
            }}
          >
            {pet.displayName}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 28,
              lineHeight: 1.35,
              color: "#202127",
              maxWidth: 620,
              marginBottom: 22,
            }}
          >
            {clip(pet.description, 130)}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 22,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              color: "#5b6076",
            }}
          >
            {tagsLine}
          </div>
        </div>
      </div>

      {/* Bottom install bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 56px 44px 56px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "16px 24px",
            borderRadius: 999,
            background: "#0a0a0a",
            color: "#fff",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 26,
            fontWeight: 500,
          }}
        >
          <span style={{ color: "#7a8dff", marginRight: 16 }}>$</span>
          npx petdex install {pet.slug}
        </div>
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
          petdex.crafter.run
        </div>
      </div>
    </div>,
    { ...size },
  );
}

async function getOgImageCopy(locale: string) {
  const resolvedLocale = locale && hasLocale(locale) ? locale : defaultLocale;
  const messages = (await import(`@/i18n/messages/${resolvedLocale}.json`))
    .default as {
    ogImage?: { featuredPet?: string; codexPet?: string };
  };

  return {
    featuredPet: messages.ogImage?.featuredPet ?? "Featured Codex pet",
    codexPet: messages.ogImage?.codexPet ?? "Codex pet",
  };
}

async function loadFirstFrameAsDataUrl(url: string): Promise<string | null> {
  // Defensive SSRF guard. Even though pet.spritesheetPath comes from the DB,
  // the row was originally populated from a user submission. A row predating
  // the validateSubmission allowlist could still have an external URL, and
  // we'd happily fetch it server-side from a Vercel runtime that may sit on
  // an internal network with metadata endpoints. Refuse anything that isn't
  // on our R2 / UT host allowlist.
  if (!isAllowedAssetUrl(url)) {
    console.warn("[og] blocked off-allowlist sprite url");
    return null;
  }
  try {
    // No `cache: "force-cache"` — sprites are >2MB and Next's data cache caps
    // at 2MB. R2 + the route's own ISR handle caching at the CDN edge.
    const res = await fetch(url, { redirect: "error" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());

    // Crop the first idle frame (top-left cell of the 6×9 grid), upscale
    // with nearest-neighbor to keep crisp pixels, and encode as PNG so
    // Satori can decode it directly at the target size.
    const png = await sharp(buf)
      .extract({ left: 0, top: 0, width: FRAME_W, height: FRAME_H })
      .resize(DISPLAY_W, DISPLAY_H, { kernel: "nearest" })
      .png()
      .toBuffer();

    return `data:image/png;base64,${png.toString("base64")}`;
  } catch (err) {
    console.warn("[og] sprite decode failed:", (err as Error).message);
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

function StarMark({ size }: { size: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      fill="#5266ea"
      style={{ display: "flex" }}
    >
      <path d="M12 2l2.9 6.9 7.4.6-5.6 4.9 1.7 7.3-6.4-3.9-6.4 3.9 1.7-7.3L1.7 9.5l7.4-.6L12 2z" />
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
