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
  requestQuery: string;
};

export function renderRequestFulfilledRequesterEmail(
  locale: Locale,
  vars: Vars,
): { subject: string; html: string; text: string } {
  const current = normalizeLocale(locale);
  const petUrl = petdexUrl(current, `/pets/${vars.petSlug}`);
  const installCmd = `curl -sSf https://petdex.crafter.run/install/${vars.petSlug} | sh`;

  const copy =
    current === "es"
      ? {
          subject: `Tu pedido "${vars.requestQuery}" ya tiene mascota`,
          intro: `${vars.petName} cumple tu pedido en Petdex.`,
          install: "Comando de instalación",
          cta: `Página: ${petUrl}`,
        }
      : current === "zh"
        ? {
            subject: `你的请求 "${vars.requestQuery}" 已被满足`, // fixme:zh
            intro: `${vars.petName} 满足了你在 Petdex 的请求。`, // fixme:zh
            install: "安装命令", // fixme:zh
            cta: `页面：${petUrl}`, // fixme:zh
          }
        : {
            subject: `Your request "${vars.requestQuery}" has a pet`,
            intro: `${vars.petName} fulfills your request on Petdex.`,
            install: "Install command",
            cta: `Page: ${petUrl}`,
          };

  const text = [
    copy.intro,
    "",
    copy.cta,
    "",
    `${copy.install}:`,
    installCmd,
    "",
    "Petdex",
  ].join("\n");
  const html = wrapEmail(copy.subject, [
    p(copy.intro),
    p(copy.cta),
    p(copy.install),
    codeBlock(installCmd),
  ]);

  return { subject: copy.subject, html, text };
}
