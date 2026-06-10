import {
  buildUnsubscribeFooter,
  normalizeLocale,
  petdexUrl,
} from "@/lib/email-templates/shared";

import type { Locale } from "@/i18n/config";

type Vars = {
  unsubscribeToken: string;
};

// Brand palette (matches the site's --brand OKLCH tokens, expressed as
// hex). Inlined because mail clients don't process CSS variables and
// many don't support OKLCH. BRAND_DEEP carries the chip text color;
// BRAND_TINT is the body wash + icon border. The primary CTA stays
// black on purpose — purple-on-purple was hard to scan.
const BRAND_DEEP = "#3847f5";
const BRAND_TINT = "#eef1ff";

const ICON_URL = "https://petdex.dev/brand/petdex-desktop-icon.png";

export function renderDesktopLaunchEmail(
  locale: Locale,
  vars: Vars,
): { subject: string; html: string; text: string } {
  const current = normalizeLocale(locale);

  const copy =
    current === "es"
      ? {
          subject: "Petdex Desktop ya está aquí",
          headline: "Tu mascota, junto a tu agente.",
          intro:
            "La app de macOS narra cada tool call de tu agente con bubbles cortos.",
          ctaPrimary: "Descargar para macOS",
          ctaSecondary: "Explorar mascotas",
          tagline: "macOS Apple Silicon · Windows + Linux pronto",
        }
      : current === "zh"
        ? {
            subject: "Petdex Desktop 上线了",
            headline: "你的宠物，陪在 agent 旁。",
            intro: "macOS 桌面应用，用短气泡叙述 agent 的每次工具调用。",
            ctaPrimary: "下载 macOS 版",
            ctaSecondary: "浏览宠物",
            tagline: "macOS Apple Silicon · Windows + Linux 即将推出",
          }
        : {
            subject: "Petdex Desktop is here",
            headline: "Your pet, by your agent.",
            intro:
              "The macOS app narrates every tool call your agent makes with short bubbles.",
            ctaPrimary: "Download for macOS",
            ctaSecondary: "Browse pets",
            tagline: "macOS Apple Silicon · Windows + Linux coming",
          };

  // Sample bubbles — same strings the real desktop UI renders. Kept
  // English across locales because they ARE the literal output of
  // the agent hooks (which run in their own locale-agnostic flow).
  const bubbleSamples = ["Reading server.ts", "Editing main.zig", "Done."];

  const agents = ["Claude Code", "Codex CLI", "OpenCode", "Gemini CLI"];

  const downloadUrl = petdexUrl(current, "/download");
  const petsUrl = petdexUrl(current, "/pets");

  const text = [
    copy.headline,
    "",
    copy.intro,
    "",
    `Works with: ${agents.join(", ")}`,
    "",
    bubbleSamples.map((b) => `  • ${b}`).join("\n"),
    "",
    `${copy.ctaPrimary}: ${downloadUrl}`,
    `${copy.ctaSecondary}: ${petsUrl}`,
    "",
    copy.tagline,
    buildUnsubscribeFooter(current, vars.unsubscribeToken).text,
  ].join("\n");

  // ─── HTML composition ────────────────────────────────────────────
  // Vertically: icon → headline → 1-line intro → bubble strip → agents
  // chips → CTAs → tagline. ~5 visual blocks, fits in a single screen
  // height on most clients. Brand color (#5266ea) for the primary
  // button and chip borders to stay on-system.

  // Brand lockup: icon + wordmark side-by-side. Using a table-row
  // because mail clients (Outlook especially) treat flexbox as
  // Suggestions Only, but vertical-align on a <table> works
  // everywhere. The wordmark is rendered as text — no font load
  // dependency, no SVG support quirks.
  const iconBlock = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;border-collapse:collapse;">
    <tr>
      <td style="vertical-align:middle;padding:0 12px 0 0;">
        <img src="${ICON_URL}" alt="" width="48" height="48" style="display:block;width:48px;height:48px;border-radius:12px;border:1px solid ${BRAND_TINT};box-shadow:0 4px 12px rgba(82,102,234,0.15);" />
      </td>
      <td style="vertical-align:middle;">
        <span style="display:block;color:#0a0a0a;font-size:18px;font-weight:700;letter-spacing:-0.01em;line-height:1;">Petdex Desktop</span>
      </td>
    </tr>
  </table>`;

  const headlineBlock = `<h1 style="margin:0 0 8px;color:#0a0a0a;font-size:22px;font-weight:700;letter-spacing:-0.015em;line-height:1.25;">${copy.headline}</h1>`;

  const introBlock = `<p style="margin:0 0 22px;color:#404040;font-size:14px;line-height:1.55;">${copy.intro}</p>`;

  // Bubble strip — match the actual desktop UI exactly: white card,
  // black text, 600 monospace, soft shadow. This is the "look at me"
  // moment of the email.
  const bubbleStrip = bubbleSamples
    .map(
      (text) =>
        `<span style="display:inline-block;margin:0 6px 6px 0;padding:5px 11px;border-radius:9px;background:#ffffff;border:1px solid #e7e5e4;color:#0a0a0a;font:600 12px ui-monospace, SFMono-Regular, Menlo, monospace;box-shadow:0 1px 3px rgba(0,0,0,0.06);">${text}</span>`,
    )
    .join("");

  const bubbleBlock = `<div style="margin:0 0 22px;">${bubbleStrip}</div>`;

  // Agent chips — brand-tinted pills. Same visual weight as the
  // bubble strip so the eye reads "this is what speaks, this is who
  // it speaks for".
  const agentChips = agents
    .map(
      (name) =>
        `<span style="display:inline-block;margin:0 6px 6px 0;padding:4px 10px;border-radius:999px;background:${BRAND_TINT};color:${BRAND_DEEP};font-size:11px;font-weight:600;">${name}</span>`,
    )
    .join("");

  const agentsBlock = `<div style="margin:0 0 28px;">${agentChips}</div>`;

  const ctaBlock = `<div style="margin:0 0 22px;">
    <a href="${downloadUrl}" style="display:inline-block;padding:12px 22px;background:#0a0a0a;color:#ffffff;border-radius:999px;font-size:13px;font-weight:600;text-decoration:none;margin:0 8px 8px 0;">${copy.ctaPrimary} →</a>
    <a href="${petsUrl}" style="display:inline-block;padding:12px 22px;background:transparent;color:#0a0a0a;border:1px solid #d6d3d1;border-radius:999px;font-size:13px;font-weight:500;text-decoration:none;">${copy.ctaSecondary}</a>
  </div>`;

  const taglineBlock = `<p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #f5f5f4;color:#a8a29e;font-size:12px;line-height:1.5;">${copy.tagline}</p>`;

  // We bypass wrapBroadcastEmail because that helper auto-prepends an
  // <h1> with the subject line, which would double-stack with our own
  // headline. Hand-rolling the wrapper keeps the visual hierarchy
  // tight: icon → headline → intro → bubbles → agents → CTAs.
  const footer = buildUnsubscribeFooter(current, vars.unsubscribeToken);
  const html = [
    "<!doctype html>",
    `<html><body style="margin:0;padding:24px;background:${BRAND_TINT};color:#171717;font-family:ui-sans-serif,system-ui,sans-serif;">`,
    `<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:28px;">`,
    iconBlock,
    headlineBlock,
    introBlock,
    bubbleBlock,
    agentsBlock,
    ctaBlock,
    taglineBlock,
    footer.html,
    "</div></body></html>",
  ].join("");

  return { subject: copy.subject, html, text };
}
