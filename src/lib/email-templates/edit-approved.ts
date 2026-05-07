import {
  normalizeLocale,
  p,
  petdexUrl,
  wrapEmail,
} from "@/lib/email-templates/shared";

import type { Locale } from "@/i18n/config";

type Vars = {
  petName: string;
  petSlug: string;
};

export function renderEditApprovedEmail(
  locale: Locale,
  vars: Vars,
): { subject: string; html: string; text: string } {
  const current = normalizeLocale(locale);
  const pageUrl = petdexUrl(current, `/pets/${vars.petSlug}`);
  const copy =
    current === "es"
      ? {
          subject: `Tu edición de ${vars.petName} ya está publicada`,
          intro: `Tu edición de "${vars.petName}" fue aprobada.`,
        }
      : current === "zh"
        ? {
            subject: `你对 ${vars.petName} 的修改已上线`, // fixme:zh
            intro: `你对“${vars.petName}”的修改已通过审核。`, // fixme:zh
          }
        : {
            subject: `Your edit to ${vars.petName} is live`,
            intro: `Your edit to "${vars.petName}" was approved.`,
          };

  const text = [copy.intro, "", `Page: ${pageUrl}`, "", "Petdex"].join("\n");
  const html = wrapEmail(copy.subject, [p(copy.intro), p(`Page: ${pageUrl}`)]);

  return { subject: copy.subject, html, text };
}
