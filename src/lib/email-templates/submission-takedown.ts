import {
  normalizeLocale,
  p,
  petdexUrl,
  sanitizeSubject,
  wrapEmail,
} from "@/lib/email-templates/shared";

import type { Locale } from "@/i18n/config";

type Vars = {
  petName: string;
  reason: string | null;
};

export function renderSubmissionTakedownEmail(
  locale: Locale,
  vars: Vars,
): { subject: string; html: string; text: string } {
  const current = normalizeLocale(locale);
  const submitUrl = petdexUrl(current, "/submit");
  const copy =
    current === "es"
      ? {
          subject: `Tu mascota fue retirada de Petdex: ${vars.petName}`,
          intro: `Hola, tu mascota "${vars.petName}" fue retirada de Petdex y sus archivos fueron eliminados.`,
          noReason:
            "No se indicó una razón pública. El slug queda libre por si quieres volver a enviarla.",
          cta: `Si quieres subir una nueva versión, puedes hacerlo aquí: ${submitUrl}`,
        }
      : current === "zh"
        ? {
            subject: `你的宠物已从 Petdex 下架：${vars.petName}`, // fixme:zh
            intro: `你好，你的宠物“${vars.petName}”已从 Petdex 下架，相关文件也已删除。`, // fixme:zh
            noReason: "没有提供公开原因。该 slug 已释放，你可以重新提交。", // fixme:zh
            cta: `如需上传新版本，请前往：${submitUrl}`, // fixme:zh
          }
        : {
            subject: `Your pet was taken down from Petdex: ${vars.petName}`,
            intro: `Hey, your pet "${vars.petName}" was taken down from Petdex and its files were removed.`,
            noReason:
              "No public reason was given. The slug is free again if you want to resubmit.",
            cta: `If you want to upload a new version, you can do so here: ${submitUrl}`,
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

  return { subject: sanitizeSubject(copy.subject), html, text };
}
