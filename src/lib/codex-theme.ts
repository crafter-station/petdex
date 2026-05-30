// Generates Codex Desktop themes (codex-theme-v1 format) from a pet's
// dominant color. Codex stores its appearance in two LocalStorage keys
// (appearanceLightChromeTheme, appearanceDarkChromeTheme) and there is
// no official deep link to write them, so we ship the JSON to the
// clipboard and let the user paste it into Settings -> Appearance.
//
// Schema reverse-engineered from /Applications/Codex.app/Contents/
// Resources/app.asar (webview/assets/gpu-tearing-debug-settings).
//
// codeThemeId notes
// -----------------
// Codex resolves codeThemeId via a dynamic import map; only ids that
// match a chunk in webview/assets/<id>-<hash>.js are accepted. Pass
// anything else and the Settings 'Create theme' button stays disabled.
// Below is the full list extracted from the bundle (Codex 1.x). Keep
// in sync if Codex ships new themes.

export const CODEX_LIGHT_THEME_IDS = [
  "light-plus",
  "github-light-default",
  "catppuccin-latte",
  "everforest-light",
  "gruvbox-light-medium",
  "solarized-light",
  "one-light",
  "rose-pine-dawn",
] as const;

export const CODEX_DARK_THEME_IDS = [
  "dark-plus",
  "github-dark-default",
  "catppuccin-mocha",
  "everforest-dark",
  "gruvbox-dark-medium",
  "solarized-dark",
  "one-dark-pro",
  "rose-pine-moon",
  "ayu-dark",
  "material-theme-darker",
  "night-owl",
  "tokyo-night",
] as const;

export type CodexLightThemeId = (typeof CODEX_LIGHT_THEME_IDS)[number];
export type CodexDarkThemeId = (typeof CODEX_DARK_THEME_IDS)[number];

export type CodexThemeBlock = {
  accent: string;
  contrast: number;
  fonts: { code: null; ui: null };
  ink: string;
  opaqueWindows: boolean;
  semanticColors: {
    diffAdded: string;
    diffRemoved: string;
    skill: string;
  };
  surface: string;
};

export type CodexThemeVariant = {
  codeThemeId: string;
  theme: CodexThemeBlock;
  variant: "light" | "dark";
};

export type CodexTheme = {
  light: CodexThemeVariant;
  dark: CodexThemeVariant;
};

function parseHex(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "").trim();
  if (clean.length !== 6) return { r: 128, g: 128, b: 128 };
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function toHex(r: number, g: number, b: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const h = (n: number) => clamp(n).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Mix two colors; t=0 is a, t=1 is b.
function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex(
    ca.r + (cb.r - ca.r) * t,
    ca.g + (cb.g - ca.g) * t,
    ca.b + (cb.b - ca.b) * t,
  );
}

// Relative luminance per WCAG. Used to score contrast.
function luminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  const linearize = (channel: number) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

function contrastRatio(bg: string, fg: string): number {
  const a = luminance(bg);
  const b = luminance(fg);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  // Codex stores contrast as a 0-100 percent against the WCAG max (21).
  return Math.round(Math.min(ratio / 0.21, 1) * 100);
}

const _WHITE = "#ffffff";
const BLACK = "#0b0b0d";
const NEAR_WHITE = "#f7f7f8";
const NEAR_BLACK = "#1a1a1e";

function makeBlock(accent: string, mode: "light" | "dark"): CodexThemeBlock {
  const surface =
    mode === "light"
      ? mix(accent, NEAR_WHITE, 0.92)
      : mix(accent, NEAR_BLACK, 0.85);
  const ink = mode === "light" ? BLACK : NEAR_WHITE;
  // Diff colors: shift accent hue toward green/red without losing the
  // pet's signature tint. Mixing with pure colors at a moderate ratio
  // keeps the palette cohesive instead of looking like the default
  // VS Code green/red on top of a custom accent.
  const diffAdded =
    mode === "light"
      ? mix(accent, "#1f9d55", 0.55)
      : mix(accent, "#22c55e", 0.55);
  const diffRemoved =
    mode === "light"
      ? mix(accent, "#c53030", 0.55)
      : mix(accent, "#ef4444", 0.55);
  const skill = mix(accent, mode === "light" ? "#2563eb" : "#60a5fa", 0.4);

  return {
    accent,
    contrast: contrastRatio(surface, ink),
    fonts: { code: null, ui: null },
    ink,
    opaqueWindows: false,
    semanticColors: { diffAdded, diffRemoved, skill },
    surface,
  };
}

// HOTFIX: Codex Settings keeps the "Create theme" button disabled when
// codeThemeId is light-plus / dark-plus / most of the other names that
// look like the registry. Empirically only "one" lets the button enable.
// Hardcoding both variants to "one" until we map which ids actually
// pass the live validator versus the stale set we extracted from the
// asar.
const CODEX_THEME_ID = "one";

export function buildCodexTheme(dominantColor: string): CodexTheme {
  return {
    light: {
      codeThemeId: CODEX_THEME_ID,
      theme: makeBlock(dominantColor, "light"),
      variant: "light",
    },
    dark: {
      codeThemeId: CODEX_THEME_ID,
      theme: makeBlock(dominantColor, "dark"),
      variant: "dark",
    },
  };
}

// Codex Settings has two separate Import boxes (Light theme + Dark
// theme), each accepting a single `codex-theme-v1:<json>` string. We
// expose the two variants as standalone strings rather than a combined
// JSON so each can be copied and pasted directly without the user
// hand-extracting one half.
export function serializeCodexThemeVariant(variant: CodexThemeVariant): string {
  return `codex-theme-v1:${JSON.stringify(variant)}`;
}
