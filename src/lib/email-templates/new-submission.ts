import type { Locale } from "@/i18n/config";
import { normalizeLocale, p, wrapEmail } from "@/lib/email-templates/shared";

type Vars = {
  displayName: string;
  slug: string;
  from: string;
  description: string;
  spritesheetUrl: string;
  zipUrl: string;
};

export function renderNewSubmissionEmail(
  locale: Locale,
  vars: Vars,
): { subject: string; html: string; text: string } {
  const current = normalizeLocale(locale);
  const copy =
    current === "es"
      ? {
          subject: `Nueva mascota enviada: ${vars.displayName}`,
          pet: "Mascota",
          from: "Enviado por",
          sprite: "Sprite",
          zip: "Zip",
        }
      : current === "zh"
        ? {
            subject: `新宠物提交：${vars.displayName}`, // fixme:zh
            pet: "宠物", // fixme:zh
            from: "提交者", // fixme:zh
            sprite: "Sprite",
            zip: "Zip",
          }
        : {
            subject: `New pet submission: ${vars.displayName}`,
            pet: "Pet",
            from: "From",
            sprite: "Sprite",
            zip: "Zip",
          };

  const text = [
    `${copy.pet}: ${vars.displayName} (${vars.slug})`,
    `${copy.from}: ${vars.from}`,
    "",
    vars.description,
    "",
    `${copy.sprite}: ${vars.spritesheetUrl}`,
    `${copy.zip}: ${vars.zipUrl}`,
  ].join("\n");

  const html = wrapEmail(copy.subject, [
    p(`${copy.pet}: ${vars.displayName} (${vars.slug})`),
    p(`${copy.from}: ${vars.from}`),
    p(vars.description),
    p(`${copy.sprite}: ${vars.spritesheetUrl}`),
    p(`${copy.zip}: ${vars.zipUrl}`),
  ]);

  return { subject: copy.subject, html, text };
}
