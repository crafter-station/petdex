import {
  buildUnsubscribeFooter,
  escapeHtml,
  normalizeLocale,
  p,
  petdexUrl,
  wrapBroadcastEmail,
} from "@/lib/email-templates/shared";

import type { Locale } from "@/i18n/config";

type CollectionPreview = {
  slug: string;
  title: string;
  description: string;
};

type Vars = {
  collections: CollectionPreview[];
  unsubscribeToken: string;
};

export function renderCollectionsDropEmail(
  locale: Locale,
  vars: Vars,
): { subject: string; html: string; text: string } {
  const current = normalizeLocale(locale);

  const copy =
    current === "es"
      ? {
          subject: "10 colecciones nuevas en Petdex. Descubre la tuya",
          intro:
            "Acabamos de organizar todos los pets en 10 colecciones con identidad. Tu pet ya pertenece a una.",
          cta: "Ver mis colecciones",
        }
      : current === "zh"
        ? {
            subject: "Petdex 推出 10 个全新合集，看看你的宠物属于哪一个",
            intro:
              "我们把所有宠物归入了 10 个有故事感的合集。你的宠物已经在其中一个里了。",
            cta: "查看我的合集",
          }
        : {
            subject: "10 fresh collections on Petdex. Find yours",
            intro:
              "We just sorted every pet into 10 themed collections with real identity. Yours already belongs to one.",
            cta: "See my collections",
          };

  const collectionsUrl = petdexUrl(current, "/collections");

  const collectionLines = vars.collections
    .map((c) => `${c.title}: ${c.description}`)
    .join("\n");

  const text = [
    copy.intro,
    "",
    collectionLines,
    "",
    `${copy.cta}: ${collectionsUrl}`,
    buildUnsubscribeFooter(current, vars.unsubscribeToken).text,
  ].join("\n");

  const collectionBlocks = vars.collections.map((c) => {
    const url = petdexUrl(current, `/collections/${c.slug}`);
    // Title and description are user-authored collection text; every other
    // template routes its interpolations through p()/escapeHtml, and this
    // one did not — a broadcast email is the last place to skip it.
    return `<div style="margin:0 0 18px;padding:14px 16px;border:1px solid #e7e5e4;border-radius:12px;">
      <a href="${url}" style="color:#171717;text-decoration:none;font-weight:600;font-size:15px;">${escapeHtml(c.title)}</a>
      <div style="margin-top:4px;color:#57534e;font-size:13px;line-height:1.5;">${escapeHtml(c.description)}</div>
    </div>`;
  });

  const ctaBlock = `<div style="margin:24px 0 0;">
    <a href="${collectionsUrl}" style="display:inline-block;padding:12px 22px;background:#171717;color:#fafaf9;border-radius:999px;font-size:14px;font-weight:500;text-decoration:none;">${copy.cta}</a>
  </div>`;

  const html = wrapBroadcastEmail(
    copy.subject,
    [p(copy.intro), ...collectionBlocks, ctaBlock],
    current,
    vars.unsubscribeToken,
  );

  return { subject: copy.subject, html, text };
}
