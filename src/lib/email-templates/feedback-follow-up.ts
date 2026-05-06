import {
  normalizeLocale,
  p,
  quoteBlock,
  wrapEmail,
} from "@/lib/email-templates/shared";

import type { Locale } from "@/i18n/config";

type Vars = {
  kindLabel: string;
  statusLabel: string;
  originalMessage: string;
  replyBody: string;
  threadUrl: string;
  excerpt: string;
};

export function renderFeedbackFollowUpEmail(
  locale: Locale,
  vars: Vars,
): { subject: string; html: string; text: string } {
  const current = normalizeLocale(locale);
  const copy =
    current === "es"
      ? {
          subject: `Seguimiento de feedback de Petdex — ${vars.kindLabel}`,
          intro: "Hay un nuevo seguimiento en un hilo de feedback de Petdex.",
          original: `Original (${vars.kindLabel}, ${vars.statusLabel}):`,
          reply: "Respuesta del usuario:",
          open: `Abrir hilo: ${vars.threadUrl}`,
        }
      : current === "zh"
        ? {
            subject: `Petdex 反馈跟进 — ${vars.kindLabel}`, // fixme:zh
            intro: "有一条新的 Petdex 反馈跟进。", // fixme:zh
            original: `原始反馈（${vars.kindLabel}，${vars.statusLabel}）：`, // fixme:zh
            reply: "用户回复：", // fixme:zh
            open: `打开线程：${vars.threadUrl}`, // fixme:zh
          }
        : {
            subject: `Petdex feedback follow-up — ${vars.kindLabel}`,
            intro: "New follow-up on a Petdex feedback thread.",
            original: `Original (${vars.kindLabel}, ${vars.statusLabel}):`,
            reply: "User reply:",
            open: `Open thread: ${vars.threadUrl}`,
          };

  const text = [
    copy.intro,
    "",
    copy.original,
    `> ${vars.originalMessage.split("\n").join("\n> ")}`,
    "",
    copy.reply,
    "",
    vars.replyBody,
    "",
    "---",
    copy.open,
    `(re: "${vars.excerpt}")`,
  ].join("\n");

  const html = wrapEmail(copy.subject, [
    p(copy.intro),
    p(copy.original),
    quoteBlock(vars.originalMessage),
    p(copy.reply),
    p(vars.replyBody),
    p(copy.open),
    p(`re: "${vars.excerpt}"`),
  ]);

  return { subject: copy.subject, html, text };
}
