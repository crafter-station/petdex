import {
  codeBlock,
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

export function renderSubmissionApprovedEmail(
  locale: Locale,
  vars: Vars,
): { subject: string; html: string; text: string } {
  const current = normalizeLocale(locale);
  const pageUrl = petdexUrl(current, `/pets/${vars.petSlug}`);
  const homeUrl = petdexUrl(current, "/");
  const installCmd = `curl -sSf https://petdex.dev/install/${vars.petSlug} | sh`;
  const copy =
    current === "es"
      ? {
          subject: `${vars.petName} ya está en Petdex`,
          intro: `${vars.petName} ya está publicada en Petdex.`,
          install: "Comando de instalación",
          actions: [
            "Ajusta el nombre, la descripción o las etiquetas desde la página de la mascota.",
            "Fíjala en tu perfil público para que aparezca primero.",
            "Comparte el comando de instalación; cada instalación queda registrada en tu perfil.",
          ],
        }
      : current === "zh"
        ? {
            subject: `${vars.petName} 已在 Petdex 上线`, // fixme:zh
            intro: `${vars.petName} 刚刚在 Petdex 上线。`, // fixme:zh
            install: "安装命令", // fixme:zh
            actions: [
              "在宠物页面调整名称、描述或标签。",
              "把它置顶到你的公开资料页。",
              "分享安装命令；每次安装都会记录到你的资料里。",
            ], // fixme:zh
          }
        : {
            subject: `${vars.petName} is live on Petdex`,
            intro: `${vars.petName} just went live on Petdex.`,
            install: "Install command",
            actions: [
              "Tweak the name, description or tags from the pet page.",
              "Pin it on your public profile so it shows up first.",
              "Share the install command; every install is tracked on your profile.",
            ],
          };

  const text = [
    copy.intro,
    "",
    `Page: ${pageUrl}`,
    "",
    `${copy.install}:`,
    installCmd,
    "",
    ...copy.actions.map((line) => `- ${line}`),
    "",
    `Profile: ${homeUrl}`,
    "",
    "Petdex",
  ].join("\n");

  const html = wrapEmail(copy.subject, [
    p(copy.intro),
    p(`Page: ${pageUrl}`),
    p(copy.install),
    codeBlock(installCmd),
    p(copy.actions.map((line) => `- ${line}`).join("\n")),
    p(`Profile: ${homeUrl}`),
  ]);

  return { subject: copy.subject, html, text };
}
