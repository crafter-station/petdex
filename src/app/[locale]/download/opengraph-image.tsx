// OG image for the desktop download page. Brand-consistent with the
// rest of Petdex (cloud gradient, brand purple, mono caption) but
// leans on a "your pet, floating beside your editor" framing instead
// of a sprite grid since this page is product copy, not a pet card.

import { ImageResponse } from "next/og";

import { defaultLocale, hasLocale } from "@/i18n/config";

export const runtime = "nodejs";
export const contentType = "image/png";
export const size = { width: 1200, height: 630 };
export const alt = "Petdex Desktop — your pet beside every agent";
// 24h ISR matches the rest of the OG routes. The download landing
// copy doesn't shift often; cached unfurls are fine.
export const revalidate = 86400;

export default async function Image({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const copy = await getOgImageCopy(locale);

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
          <span>{copy.eyebrow}</span>
        </div>
      </div>

      {/* Center hero */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          flex: 1,
          padding: "0 80px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 88,
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: -2,
            color: "#0a0a0a",
            marginBottom: 24,
          }}
        >
          {copy.title}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 30,
            lineHeight: 1.3,
            color: "#202127",
            maxWidth: 940,
          }}
        >
          {copy.subtitle}
        </div>
      </div>

      {/* Install command */}
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          padding: "0 56px 28px 56px",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            background: "#0a0a0a",
            color: "#fafaf9",
            borderRadius: 999,
            padding: "16px 32px",
            fontSize: 24,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            letterSpacing: 0.5,
          }}
        >
          <span style={{ color: "#a8a29e" }}>$</span>
          <span>npx petdex install</span>
        </div>
      </div>

      {/* Bottom URL */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
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
          petdex.crafter.run/download
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
    ogImage?: {
      downloadEyebrow?: string;
      downloadTitle?: string;
      downloadSubtitle?: string;
    };
  };
  return {
    eyebrow: messages.ogImage?.downloadEyebrow ?? "Petdex Desktop",
    title: messages.ogImage?.downloadTitle ?? "Your pet, beside every agent",
    subtitle:
      messages.ogImage?.downloadSubtitle ??
      "Animated pixel companions for Codex, Claude Code, and the rest of your AI workflow. macOS native.",
  };
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
        <linearGradient
          id="og-petdex-body-download"
          x1="8"
          y1="8"
          x2="56"
          y2="56"
        >
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
        fill="url(#og-petdex-body-download)"
      />
      <circle cx="24" cy="28" r="4" fill="#fff" />
      <circle cx="40" cy="28" r="4" fill="#fff" />
      <rect x="22" y="40" width="20" height="4" rx="2" fill="#fff" />
    </svg>
  );
}
