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
  reason: string | null;
};

export function renderEditRejectedEmail(
  locale: Locale,
  vars: Vars,
): { subject: string; html: string; text: string } {
  const current = normalizeLocale(locale);
  const pageUrl = petdexUrl(current, `/pets/${vars.petSlug}`);
  const copy =
    current === "es"
      ? {
          subject: `Tu edición de ${vars.petName} necesita cambios`,
          intro: `Tu edición de "${vars.petName}" no fue aprobada en esta ronda.`,
          noReason: "No se indicó una razón.",
          cta: `Puedes revisarla desde la página de tu mascota: ${pageUrl}`,
        }
      : current === "zh"
        ? {
            subject: `你对 ${vars.petName} 的修改需要调整`, // fixme:zh
            intro: `你对“${vars.petName}”的修改这次没有通过审核。`, // fixme:zh
            noReason: "这次没有提供原因。", // fixme:zh
            cta: `你可以在宠物页面继续修改：${pageUrl}`, // fixme:zh
          }
        : {
            subject: `Your edit to ${vars.petName} needs changes`,
            intro: `Your edit to "${vars.petName}" wasn't approved this round.`,
            noReason: "No reason was provided.",
            cta: `You can revise it from your pet page: ${pageUrl}`,
          };

  const reasonLine = vars.reason ? `Reason: ${vars.reason}` : copy.noReason;
  const text = [copy.intro, "", reasonLine, "", copy.cta, "", "Petdex"].join(
    "\n",
  );
  const html = wrapEmail(copy.subject, [
    p(copy.intro),
    p(reasonLine),
    p(copy.cta),
  ]);

  return { subject: copy.subject, html, text };
}
