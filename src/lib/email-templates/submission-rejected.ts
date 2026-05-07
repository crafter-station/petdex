import type { Locale } from "@/i18n/config";
import { normalizeLocale, p, petdexUrl, wrapEmail } from "@/lib/email-templates/shared";

type Vars = {
  petName: string;
  reason: string | null;
};

export function renderSubmissionRejectedEmail(
  locale: Locale,
  vars: Vars,
): { subject: string; html: string; text: string } {
  const current = normalizeLocale(locale);
  const submitUrl = petdexUrl(current, "/submit");
  const copy =
    current === "es"
      ? {
          subject: `Tu envío a Petdex necesita cambios — ${vars.petName}`,
          intro: `Hola, tu mascota "${vars.petName}" no fue aprobada en esta ronda.`,
          noReason: "No se indicó una razón. Si quieres, itera y vuelve a enviarla.",
          cta: `Puedes enviar una versión revisada aquí: ${submitUrl}`,
        }
      : current === "zh"
        ? {
            subject: `你的 Petdex 提交需要修改 — ${vars.petName}`, // fixme:zh
            intro: `你好，你的宠物“${vars.petName}”这次没有通过审核。`, // fixme:zh
            noReason: "这次没有提供原因。你可以修改后重新提交。", // fixme:zh
            cta: `你可以在这里重新提交修订版：${submitUrl}`, // fixme:zh
          }
        : {
            subject: `Your Petdex submission needs changes — ${vars.petName}`,
            intro: `Hey, your pet "${vars.petName}" wasn't approved this round.`,
            noReason: "No reason was provided. Feel free to iterate and resubmit.",
            cta: `You can submit a revised version here: ${submitUrl}`,
          };

  const reasonLine = vars.reason ? `Reason: ${vars.reason}` : copy.noReason;
  const text = [copy.intro, "", reasonLine, "", copy.cta, "", "Petdex"].join("\n");
  const html = wrapEmail(copy.subject, [p(copy.intro), p(reasonLine), p(copy.cta)]);

  return { subject: copy.subject, html, text };
}
