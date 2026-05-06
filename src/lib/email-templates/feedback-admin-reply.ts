import {
  normalizeLocale,
  p,
  petdexUrl,
  quoteBlock,
  wrapEmail,
} from "@/lib/email-templates/shared";

import type { Locale } from "@/i18n/config";

type Vars = {
  feedbackId: string;
  originalMessage: string;
  replyBody: string;
  excerpt: string;
};

export function renderFeedbackAdminReplyEmail(
  locale: Locale,
  vars: Vars,
): { subject: string; html: string; text: string } {
  const current = normalizeLocale(locale);
  const threadUrl = petdexUrl(current, `/my-feedback/${vars.feedbackId}`);
  const copy =
    current === "es"
      ? {
          subject: "Hunter respondió a tus comentarios de Petdex",
          intro: "Hunter respondió a tus comentarios en Petdex:",
          reply: "Respuesta:",
          continue: `Sigue el hilo aquí: ${threadUrl}`,
        }
      : current === "zh"
        ? {
            subject: "Hunter 回复了你的 Petdex 反馈", // fixme:zh
            intro: "Hunter 回复了你在 Petdex 上的反馈：", // fixme:zh
            reply: "回复：", // fixme:zh
            continue: `继续查看这个讨论：${threadUrl}`, // fixme:zh
          }
        : {
            subject: "Hunter replied to your Petdex feedback",
            intro: "Hunter replied to your feedback on Petdex:",
            reply: "Reply:",
            continue: `Continue the thread: ${threadUrl}`,
          };

  const text = [
    copy.intro,
    "",
    `> ${vars.originalMessage.split("\n").join("\n> ")}`,
    "",
    copy.reply,
    "",
    vars.replyBody,
    "",
    "---",
    copy.continue,
    `(re: "${vars.excerpt}")`,
  ].join("\n");

  const html = wrapEmail(copy.subject, [
    p(copy.intro),
    quoteBlock(vars.originalMessage),
    p(copy.reply),
    p(vars.replyBody),
    p(copy.continue),
    p(`re: "${vars.excerpt}"`),
  ]);

  return { subject: copy.subject, html, text };
}
