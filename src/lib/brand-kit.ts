export const BRAND_SITE_URL = "https://petdex.dev";

export type BrandPreviewMode = "light" | "dark" | "checker";

export type BrandAssetDownload = {
  format: "svg" | "png";
  href: string;
};

export type BrandAssetEntry = {
  key:
    | "tactileMark"
    | "mark"
    | "markMonoLight"
    | "markMonoDark"
    | "wordmark"
    | "wordmarkDark"
    | "desktopIcon"
    | "appIcon"
    | "discordIcon";
  category: "logos" | "icons";
  mode: BrandPreviewMode;
  preview: string;
  downloads: readonly BrandAssetDownload[];
};

export type BrandColorToken = {
  key:
    | "cobalt"
    | "deepNavy"
    | "pearlShell"
    | "voltYellow"
    | "sakuraPink"
    | "mint";
  hex: string;
  oklch: string;
  cssVar: string;
  className: string;
};

export const BRAND_PREVIEW_BACKGROUND: Record<BrandPreviewMode, string> = {
  light: "bg-[#f7f8ff]",
  dark: "bg-[#12141f]",
  checker:
    "bg-[linear-gradient(45deg,var(--surface-muted)_25%,transparent_25%,transparent_75%,var(--surface-muted)_75%),linear-gradient(45deg,var(--surface-muted)_25%,transparent_25%,transparent_75%,var(--surface-muted)_75%)] bg-[length:20px_20px] bg-[position:0_0,10px_10px] bg-surface",
};

export const BRAND_ASSETS: readonly BrandAssetEntry[] = [
  {
    key: "tactileMark",
    category: "logos",
    mode: "light",
    preview: "/brand/petdex-tactile-mark.svg",
    downloads: [{ format: "svg", href: "/brand/petdex-tactile-mark.svg" }],
  },
  {
    key: "mark",
    category: "logos",
    mode: "light",
    preview: "/brand/petdex-mark.svg",
    downloads: [
      { format: "svg", href: "/brand/petdex-mark.svg" },
      { format: "png", href: "/brand/petdex-mark.png" },
    ],
  },
  {
    key: "wordmark",
    category: "logos",
    mode: "light",
    preview: "/brand/petdex-wordmark.svg",
    downloads: [
      { format: "svg", href: "/brand/petdex-wordmark.svg" },
      { format: "png", href: "/brand/petdex-wordmark.png" },
    ],
  },
  {
    key: "wordmarkDark",
    category: "logos",
    mode: "dark",
    preview: "/brand/petdex-wordmark-dark.svg",
    downloads: [
      { format: "svg", href: "/brand/petdex-wordmark-dark.svg" },
      { format: "png", href: "/brand/petdex-wordmark-dark.png" },
    ],
  },
  {
    key: "markMonoLight",
    category: "logos",
    mode: "light",
    preview: "/brand/petdex-mark-mono-light.svg",
    downloads: [{ format: "svg", href: "/brand/petdex-mark-mono-light.svg" }],
  },
  {
    key: "markMonoDark",
    category: "logos",
    mode: "dark",
    preview: "/brand/petdex-mark-mono-dark.svg",
    downloads: [{ format: "svg", href: "/brand/petdex-mark-mono-dark.svg" }],
  },
  {
    key: "desktopIcon",
    category: "icons",
    mode: "checker",
    preview: "/brand/petdex-desktop-icon.png",
    downloads: [{ format: "png", href: "/brand/petdex-desktop-icon.png" }],
  },
  {
    key: "appIcon",
    category: "icons",
    mode: "checker",
    preview: "/brand/petdex-app-icon.png",
    downloads: [{ format: "png", href: "/brand/petdex-app-icon.png" }],
  },
  {
    key: "discordIcon",
    category: "icons",
    mode: "dark",
    preview: "/brand/discord-icon.png",
    downloads: [{ format: "png", href: "/brand/discord-icon.png" }],
  },
] as const;

export const BRAND_COLORS: readonly BrandColorToken[] = [
  {
    key: "cobalt",
    hex: "#3B59F2",
    oklch: "oklch(0.541 0.23 268.6)",
    cssVar: "var(--toy-cobalt)",
    className: "bg-toy-cobalt",
  },
  {
    key: "deepNavy",
    hex: "#101944",
    oklch: "oklch(0.235 0.082 270)",
    cssVar: "var(--toy-navy)",
    className: "bg-toy-navy",
  },
  {
    key: "pearlShell",
    hex: "#F7F8FC",
    oklch: "oklch(0.98 0.005 275)",
    cssVar: "var(--shell-pearl)",
    className: "bg-[#F7F8FC]",
  },
  {
    key: "voltYellow",
    hex: "#FFE259",
    oklch: "oklch(0.912 0.155 97.2)",
    cssVar: "var(--toy-volt)",
    className: "bg-toy-volt",
  },
  {
    key: "sakuraPink",
    hex: "#FF7AA2",
    oklch: "oklch(0.744 0.166 3)",
    cssVar: "var(--toy-sakura)",
    className: "bg-toy-sakura",
  },
  {
    key: "mint",
    hex: "#34D399",
    oklch: "oklch(0.773 0.153 163.2)",
    cssVar: "var(--toy-mint)",
    className: "bg-toy-mint",
  },
] as const;

export const LOGO_GEOMETRY = {
  viewBox: 64,
  containerSize: 56,
  containerInset: 4,
  cornerRadius: 16,
  pixelUnit: 6,
  clearspaceRatio: 0.25,
  minimumSizesPx: [16, 24, 32, 64] as const,
} as const;

export const PETDEX_MARK_SVG_SNIPPET = `<svg fill="none" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="petdex-body" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
      <stop stop-color="#3847f5"/>
      <stop offset="1" stop-color="#1a1d2e"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="56" height="56" rx="16" fill="url(#petdex-body)"/>
  <g fill="#ffffff">
    <rect x="22" y="20" width="6" height="6"/>
    <rect x="36" y="20" width="6" height="6"/>
    <rect x="16" y="26" width="6" height="18"/>
    <rect x="42" y="26" width="6" height="18"/>
    <rect x="22" y="38" width="20" height="6"/>
  </g>
</svg>`;

export const PETDEX_TACTILE_IMG_SNIPPET = `<img src="https://petdex.dev/brand/petdex-tactile-mark.svg" width="64" height="64" alt="Petdex" />`;

export const PETDEX_BADGE_MARKDOWN_SNIPPET = `[![Available on Petdex](https://petdex.dev/brand/petdex-mark.svg)](https://petdex.dev)`;

export const BRAND_JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://crafter.run/#organization",
      name: "Crafter Station",
      url: "https://crafter.run",
      sameAs: ["https://github.com/crafter-station"],
      founder: { "@id": "https://railly.dev/#person" },
    },
    {
      "@type": "Person",
      "@id": "https://railly.dev/#person",
      name: "Railly Hugo",
      alternateName: "raillyhugo",
      url: "https://railly.dev",
      sameAs: ["https://github.com/Railly", "https://x.com/raillyhugo"],
      worksFor: { "@id": "https://crafter.run/#organization" },
    },
    {
      "@type": "WebSite",
      "@id": `${BRAND_SITE_URL}/#website`,
      name: "Petdex",
      url: BRAND_SITE_URL,
      creator: { "@id": "https://railly.dev/#person" },
      publisher: { "@id": "https://crafter.run/#organization" },
    },
  ],
} as const;
